import { releaseTier1Slot } from '../../src/reliability/tier1-state.ts';
import type { RuntimeNode } from '../../src/types/node.ts';
import type { ConversionContext, LoopContext, LoopState } from '../../src/types/request.ts';
import type { RoutableRequest, TierMap } from '../../src/types/scheduler.ts';
import { dispatchWithHedge } from './attempt/hedge.ts';
import { TIER_ORDER } from './policy/router.ts';
import {
  isCredentialWideFailure,
  isIndependentKeyRecovery,
  isSpeculativeRetryAfter,
  preferUntriedCredentials,
  preferUntriedFailureProviders,
} from './reliability/retry-budget.ts';
import { buildBudgetExhaustedResponse } from './response/errors.ts';
import { computeTierCaps, countRemainingDispatchableAttempts, pickForTier, redistributeUnusedTierAttempts } from './scheduling/tier-policy.ts';
import { recordTier1AffinityDecision } from './scheduling/tier1-affinity.ts';

function mayDispatchNextAttempt(state: LoopState, candidate: RuntimeNode): boolean {
  if (state.retryShed) return false;
  const last = state.attempts.at(-1);
  if (!last || !isSpeculativeRetryAfter(last.kind)) return true;
  const lastNode = typeof last.node_id === 'string' ? state.nodes?.find((node) => node.id === last.node_id) : undefined;
  const independentKey = isIndependentKeyRecovery(lastNode, candidate);
  if (!state.retrySlot || state.retrySlot.tryAcquire(independentKey)) return true;
  state.retryShed = true;
  state.logger.info(
    `retry-budget shed request=${state.requestId} after=${String(last.kind)} attempts=${state.logicalAttempts} independent_key=${independentKey}`,
  );
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
    imageInputRequired,
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
      const pickOpts = {
        affinityAccountId: tierNumber === 1 ? tier1Affinity : null,
        evaluateAffinity: tierNumber === 1 && tier1EvaluateAffinity,
        rng: tier1Rng,
        knownModels,
        raceLostIds,
        maxInFlight: policy.maxInFlight ?? null,
      };
      const knownNodes = state.nodes ?? [...tiers[1], ...tiers[2]];
      const dispatchedAttempts = state.attempts.filter((attempt) => attempt.dispatched === true);
      const strictlyAttempted =
        preferUntriedCredentials(
          tiers[tierNumber],
          knownNodes,
          dispatchedAttempts.filter(isCredentialWideFailure).map((attempt) => String(attempt.node_id ?? '')),
          state.attempted,
        ) ?? state.attempted;
      const providerPreferredAttempted = preferUntriedFailureProviders(tiers[tierNumber], knownNodes, dispatchedAttempts, strictlyAttempted);
      const preferredAttempted = preferUntriedCredentials(
        tiers[tierNumber],
        knownNodes,
        dispatchedAttempts.map((attempt) => String(attempt.node_id ?? '')),
        providerPreferredAttempted ?? strictlyAttempted,
      );
      const pick =
        (preferredAttempted ? pickForTier(tierNumber, tiers[tierNumber], reqDescriptor, preferredAttempted, pickOpts) : null) ??
        (providerPreferredAttempted ? pickForTier(tierNumber, tiers[tierNumber], reqDescriptor, providerPreferredAttempted, pickOpts) : null) ??
        pickForTier(tierNumber, tiers[tierNumber], reqDescriptor, strictlyAttempted, pickOpts);
      if (!pick) break;
      if (pick.raceLost) {
        if (!pick.raceLostNodeId) break;
        raceLostIds.add(pick.raceLostNodeId);
        continue;
      }
      const node = pick.node as RuntimeNode;
      if (!mayDispatchNextAttempt(state, node)) {
        if (tierNumber === 1) releaseTier1Slot(node.id, pick.tier1ReleaseToken ?? null);
        return null;
      }
      if (tierNumber === 1) {
        recordTier1AffinityDecision({
          affinityHit: pick.tier1AffinityHit,
          escaped: pick.tier1EscapedFromAffinity,
        });
      }
      let outcome: Awaited<ReturnType<typeof dispatchWithHedge>>;
      try {
        outcome = await dispatchWithHedge(
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
            imageInputRequired,
            limits,
            exposeUpstreamInfo,
            state,
            failoverBudgetMs,
            requestStartMs,
            attemptDeadlineMs: requestStartMs + failoverBudgetMs,
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
      } finally {
        state.retrySlot?.release();
      }
      if (outcome.budgetCharged) {
        usedInTier++;
        state.tierAttemptsUsed = state.tierAttemptsUsed ?? {};
        state.tierAttemptsUsed[tierNumber] = (state.tierAttemptsUsed[tierNumber] ?? 0) + 1;
      }
      if (outcome.response) return outcome.response;
      if (outcome.stop) break;
    }
    if (!overrideTierCaps && usedInTier < cap) {
      redistributeUnusedTierAttempts(tierCaps, tierNumber, cap - usedInTier, policy);
    }
  }
  return null;
}
