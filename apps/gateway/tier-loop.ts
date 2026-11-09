// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Gateway-owned physical attempt orchestration. The request handler owns
// authorization and model rounds; this module alone owns Tier loop dispatch,
// request-wide attempt accounting and retry admission. Capability centers
// only execute one physical attempt, and must not introduce a second scheduler.

import { dispatchWithHedge } from '../../src/request/attempt.ts';
import { recordTier1AffinityDecision } from '../../src/scheduler/tier1-affinity.ts';
import type { RuntimeNode } from '../../src/types/node.ts';
import type { ConversionContext, LoopContext, LoopState } from '../../src/types/request.ts';
import type { RoutableRequest, TierMap } from '../../src/types/scheduler.ts';
import { TIER_ORDER } from './policy/router.ts';
import { isSpeculativeRetryAfter } from './reliability/retry-budget.ts';
import { buildBudgetExhaustedResponse } from './response/errors.ts';
import { computeTierCaps, countRemainingDispatchableAttempts, pickForTier, redistributeUnusedTierAttempts } from './scheduling/tier-policy.ts';

// Whether the next attempt may be dispatched. A retry after an upstream that was
// slow or failing (not a plain pool rotation) draws on the isolate retry budget;
// once it is refused the request stops trying instead of walking the whole pool.
function mayDispatchNextAttempt(state: LoopState): boolean {
  if (state.retryShed) return false;
  const last = state.attempts.at(-1);
  if (!last || !isSpeculativeRetryAfter(last.kind)) return true;
  if (!state.retrySlot || state.retrySlot.tryAcquire()) return true;
  state.retryShed = true;
  state.logger.info(`retry-budget shed request=${state.requestId} after=${String(last.kind)} attempts=${state.logicalAttempts}`);
  return false;
}

export async function runTierLoop(
  loopCtx: LoopContext,
  reqDescriptor: RoutableRequest,
  conversionContext: ConversionContext | null,
  overrideTierCaps?: TierMap<number> | null,
): Promise<Response | null> {
  const {
    request,
    env,
    ctx,
    logger,
    requestId,
    route,
    requestedModel,
    clientWantsStream,
    fakeStream,
    bodyJson,
    rawBody,
    limits,
    exposeUpstreamInfo,
    state,
    failoverBudgetMs,
    requestStartMs,
    policy,
    tiers,
    tier1Affinity,
    tier1EvaluateAffinity,
    tier1Rng,
    tier1Session,
    knownModels,
    futureAttemptReserve,
  } = loopCtx;
  const tierCaps =
    overrideTierCaps ??
    computeTierCaps(tiers, reqDescriptor, state.attempted, policy, knownModels, policy.maxInFlight ?? null, state.tierAttemptsUsed);
  for (const tierNumber of TIER_ORDER) {
    const cap = tierCaps[tierNumber] ?? 0;
    let usedInTier = 0;
    const raceLostIds = new Set<string>();
    while (usedInTier < cap && state.logicalAttempts < policy.maxAttempts) {
      const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
      if (remainingBudgetMs <= 0) {
        return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
      }
      if (!mayDispatchNextAttempt(state)) return null;
      const currentPassRemaining = countRemainingDispatchableAttempts(
        tiers,
        reqDescriptor,
        state.attempted,
        tierCaps,
        tierNumber,
        usedInTier,
        policy.maxAttempts - state.logicalAttempts,
        knownModels,
        policy.maxInFlight ?? null,
      );
      const requestRemaining = Math.max(1, state.maxAttempts - state.logicalAttempts);
      const remainingDispatchableAttempts = Math.max(1, Math.min(requestRemaining, currentPassRemaining + Math.max(0, futureAttemptReserve)));
      const pick = pickForTier(tierNumber, tiers[tierNumber], reqDescriptor, state.attempted, {
        affinityAccountId: tierNumber === 1 ? tier1Affinity : null,
        evaluateAffinity: tierNumber === 1 && tier1EvaluateAffinity,
        rng: tier1Rng,
        knownModels,
        raceLostIds,
        maxInFlight: policy.maxInFlight ?? null,
      });
      if (!pick) break;
      if (pick.raceLost) {
        if (!pick.raceLostNodeId) break;
        raceLostIds.add(pick.raceLostNodeId);
        continue;
      }
      const node = pick.node as RuntimeNode;
      if (tierNumber === 1) {
        recordTier1AffinityDecision({
          affinityHit: pick.tier1AffinityHit,
          escaped: pick.tier1EscapedFromAffinity,
        });
      }
      const outcome = await dispatchWithHedge(
        {
          request,
          env,
          ctx,
          logger,
          requestId,
          route,
          node,
          requestedModel,
          clientWantsStream,
          fakeStream,
          bodyJson,
          rawBody,
          limits,
          exposeUpstreamInfo,
          state,
          failoverBudgetMs,
          requestStartMs,
          reqDescriptor,
          remainingDispatchableAttempts,
          attemptCapMs: loopCtx.attemptCapMs ?? null,
          takeRemainingWindow: loopCtx.takeRemainingWindow ?? false,
          policy,
          tierNumber,
          tier1ReleaseToken: pick.tier1ReleaseToken || null,
          tier1EscapedFromAffinity: !!pick.tier1EscapedFromAffinity,
          tier1UpdateAffinity: !!pick.tier1UpdateAffinity,
          tier1AffinityAccountId: tier1Affinity,
          tier1EvaluateAffinity,
          tier1Session,
          rng: tier1Rng,
          conversionContext,
        },
        tiers[tierNumber],
      );
      if (outcome.budgetCharged) {
        usedInTier++;
        // `tier_attempts` is a request-wide cap: remember what this tier spent
        // so a later protocol-fallback or model-family pass only gets the rest.
        state.tierAttemptsUsed = state.tierAttemptsUsed ?? {};
        state.tierAttemptsUsed[tierNumber] = (state.tierAttemptsUsed[tierNumber] ?? 0) + 1;
      }
      if (outcome.response) return outcome.response;
      if (outcome.stop) break;
    }
    // A tier may have fewer live keys than its initial allocation predicted.
    // Pass unused attempts down in priority order, keeping explicit tier caps
    // and the shared request-wide ceiling intact. Protocol-fallback overrides
    // have their own explicit budgets and are not redistributed here.
    if (!overrideTierCaps && usedInTier < cap) {
      redistributeUnusedTierAttempts(tierCaps, tierNumber, cap - usedInTier, policy);
    }
  }
  return null;
}
