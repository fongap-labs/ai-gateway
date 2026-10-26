// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Main request pipeline.
//
//   auth -> route -> body -> validate -> model support check
//     -> bounded logical-model rounds:
//          -> native per-tier attempt loop
//          -> configured cross-protocol fallback for the SAME logical model
//          -> next compatible logical model when the current model pool is
//             exhausted
//
// Streaming rule: the first-event guard runs BEFORE any streaming Response is
// returned to the client; after that point transparent failover is forbidden.

import { getLimits } from '../config/timeouts.ts';
import { getLogger } from '../observability/logger.ts';
import { admitRequestBody } from '../ratelimit/body-budget.ts';
import { isSpeculativeRetryAfter, RetrySlot } from '../reliability/retry-budget.ts';
import { hydrateSharedTier1Cooldowns } from '../reliability/tier1-shared-cooldowns.ts';
import { supportsRequest } from '../scheduler/scheduler.ts';
import { readTier1Affinity, recordTier1AffinityDecision, resolveTier1SessionId, shouldEvaluateAffinity } from '../scheduler/tier1-affinity.ts';
import { tier1ModelAvailability } from '../scheduler/tier1-scheduler.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { ConversionContext, LoopContext, LoopState, RouteFeasibilityResult } from '../types/request.ts';
import type { ExecutionContextLike, GatewayEnv } from '../types/runtime.ts';
import type { RoutableRequest, TierMap } from '../types/scheduler.ts';
import { dispatchWithHedge } from './attempt.ts';
import { injectMissHeader, matchEdgeCache, resolveEdgeCachePlan, storeEdgeCacheResponse } from './edge-cache.ts';
import { buildBudgetExhaustedResponse, buildExhaustedResponse, gatewayError } from './errors.ts';
import { runFallbackChain } from './fallback.ts';
import { buildModelFallbackPlan, failedDomainNodeIds, pickNextModelPass, rememberFailedDomains } from './model-fallback.ts';
import { preflight as runPreflight } from './preflight.ts';
import { evaluateRouteFeasibility } from './route-feasibility.ts';
import { detectRoute, normalizePath, TIER_ORDER } from './router.ts';
import { computeTierCaps, countRemainingDispatchableAttempts, makeTier1Rng, pickForTier } from './tier-loop.ts';

export async function handleRequest(request: Request, env: GatewayEnv, ctx: ExecutionContextLike): Promise<Response> {
  // Concurrent large bodies can exhaust the isolate's memory; past the budget the
  // client is asked to retry instead (see ratelimit/body-budget.ts).
  // A request without a body is charged nothing, whatever its Content-Length says.
  const worstCaseBodyBytes = request.body ? getLimits(env).maxBodyBytes : 0;
  const releaseBody = admitRequestBody(Number(request.headers.get('content-length')), worstCaseBodyBytes);
  if (!releaseBody) {
    const route = detectRoute(request.method, normalizePath(new URL(request.url).pathname));
    return gatewayError(
      request,
      env,
      route,
      503,
      'Gateway is busy with other large requests; retry shortly.',
      crypto.randomUUID(),
      undefined,
      { 'retry-after': '1' },
      'gateway_body_budget_exhausted',
      true,
    );
  }
  try {
    return await handleAdmittedRequest(request, env, ctx);
  } finally {
    releaseBody();
  }
}

async function handleAdmittedRequest(request: Request, env: GatewayEnv, ctx: ExecutionContextLike): Promise<Response> {
  const retrySlot = new RetrySlot();
  try {
    return await runAdmittedRequest(request, env, ctx, retrySlot);
  } finally {
    retrySlot.end();
  }
}

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

async function runAdmittedRequest(request: Request, env: GatewayEnv, ctx: ExecutionContextLike, retrySlot: RetrySlot): Promise<Response> {
  const logger = getLogger(env);
  const pre = await runPreflight(request, env, ctx);
  if (pre.ok === false) return pre.response;
  if ('group' in pre.authResult && pre.authResult.group) {
    logger.info('request authorized', { key_group: pre.authResult.group, request_id: pre.requestId });
  }

  const {
    requestId,
    requestStartMs,
    route,
    requestedModel,
    clientWantsStream,
    fakeStream,
    bodyJson,
    rawBody,
    limits,
    exposeUpstreamInfo,
    requestDescriptor: reqDescriptor,
    config,
    tiers,
    policy,
    failoverBudgetMs,
    knownModels,
    feasibility,
  } = pre;

  // Edge cache: compute plan and check for HIT before any upstream work.
  const keyGroup = ('group' in pre.authResult && pre.authResult.group) || '';
  const edgeCachePlan = await resolveEdgeCachePlan(
    route,
    requestedModel,
    bodyJson,
    request,
    env,
    keyGroup,
    clientWantsStream,
    reqDescriptor.bodyChars,
  );
  if (edgeCachePlan) {
    const hit = await matchEdgeCache(edgeCachePlan.keyRequest, request, env);
    if (hit) return hit;
  }

  const requestPolicy = policy;
  const modelPlan = buildModelFallbackPlan(requestedModel, knownModels, requestPolicy.maxAttempts);
  const familyModels = new Set(modelPlan.flat().map((pass) => pass.model.trim().toLowerCase()));
  const familyFallback = familyModels.size > 1;

  // Request-local real failure domains. A logical sibling is not fresh
  // capacity when the same configured account resolves it to the same upstream
  // model that already failed earlier in this request. This set is also used by
  // wall-clock reserve planning so duplicate aliases do not reserve escape time
  // after their shared execution path is already known to have failed.
  const failedDomains = new Set<string>();
  const nodesById = new Map(config.nodes.map((node) => [node.id, node] as const));

  const baseFeasibility = new Map<string, RouteFeasibilityResult>([[requestedModel, feasibility]]);
  const feasibilityForModel = (model: string, excludedNodeIds?: ReadonlySet<string> | null): RouteFeasibilityResult => {
    if (!excludedNodeIds?.size) {
      const cached = baseFeasibility.get(model);
      if (cached) return cached;
    }
    const descriptor = { ...reqDescriptor, model };
    const scopedTiers = excludedNodeIds?.size
      ? (Object.fromEntries(
          TIER_ORDER.map((tierNumber) => [tierNumber, tiers[tierNumber].filter((node) => !excludedNodeIds.has(node.id))]),
        ) as TierMap<RuntimeNode[]>)
      : tiers;
    const result = evaluateRouteFeasibility({
      route,
      requestedModel: model,
      requestDescriptor: descriptor,
      tiers: scopedTiers,
      knownModels,
      env,
    });
    if (!excludedNodeIds?.size) baseFeasibility.set(model, result);
    return result;
  };

  // Request-level wall-clock reserve for future FAMILY passes. The reserve is
  // request-scoped, but it is not allowed to become phantom capacity: once a
  // credential+upstreamModel failure domain is known, future aliases that only
  // resolve to that same spent domain are filtered out before reserving time.
  const futureAttemptReserveFor = (futurePasses: ReadonlyArray<{ model: string; attemptCap: number | null }>, passAttemptCeiling: number): number => {
    if (!familyFallback) return 0;
    let slotsLeft = Math.max(0, requestPolicy.maxAttempts - passAttemptCeiling);
    if (slotsLeft === 0) return 0;
    let reserved = 0;
    for (let i = 0; i < futurePasses.length && slotsLeft > 0; i++) {
      const futurePass = futurePasses[i];
      if (!futurePass) continue;
      const excluded = failedDomainNodeIds(config.nodes, futurePass.model, failedDomains);
      if (!feasibilityForModel(futurePass.model, excluded).reachable) continue;
      const cap = futurePass.attemptCap == null ? slotsLeft : futurePass.attemptCap;
      const take = Math.min(slotsLeft, Math.max(0, cap));
      reserved += take;
      slotsLeft -= take;
    }
    return reserved;
  };

  // Three separate request-wide counters. Model switches never reset them.
  const state: LoopContext['state'] = {
    attempted: new Set<string>(),
    attempts: [],
    logicalAttempts: 0,
    dispatches: 0,
    hedges: 0,
    failureKinds: {},
    logger,
    requestId,
    retrySlot,
    maxAttempts: requestPolicy.maxAttempts,
    maxDispatches: requestPolicy.maxAttempts + limits.maxHedgesPerRequest,
    requestedModel,
    nodes: config.nodes,
    knownModels,
    tierAttemptsUsed: {},
  };

  // Affinity only chooses between Tier 1 keys. With fewer than two that can serve
  // this request there is nothing to choose, so the session costs no KV read or
  // write. A binding whose read timed out is unknown: it is neither used nor
  // overwritten by this request.
  const tier1Choices = tiers[1].filter((node) => supportsRequest(node, reqDescriptor, knownModels)).length;
  const sessionId = tier1Choices >= 2 ? resolveTier1SessionId(request) : null;
  // Long cooldowns other isolates found (a rejected key, a spent quota) are
  // adopted before scheduling; both KV reads are bounded and run together.
  const [, affinityRead] = await Promise.all([
    tiers[1].length > 0 ? hydrateSharedTier1Cooldowns(env) : undefined,
    sessionId ? readTier1Affinity(env, sessionId, ctx) : null,
  ]);
  const tier1Session = affinityRead === undefined ? null : sessionId;
  const tier1Affinity = affinityRead ?? null;
  const tier1EvaluateAffinity = shouldEvaluateAffinity(tier1Session);
  const tier1Rng = makeTier1Rng(env);

  const loopCtx: LoopContext = {
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
    bodyChars: reqDescriptor.bodyChars,
    limits,
    exposeUpstreamInfo,
    state,
    failoverBudgetMs,
    requestStartMs,
    policy: requestPolicy,
    tiers,
    tier1Affinity,
    tier1EvaluateAffinity,
    tier1Rng,
    tier1Session,
    knownModels,
    feasibility,
    futureAttemptReserve: 0,
    edgeCachePlan,
  };

  // Each round starts as a pending list in plan order. The default (requested)
  // model is taken whenever it can take the request; when it is unavailable or
  // busy, the freest sibling goes next. A pass never runs twice.
  const pendingRounds = modelPlan.map((round) => [...round]);
  const availabilityOf = (model: string): number =>
    tier1ModelAvailability(
      tiers[1],
      { ...reqDescriptor, model },
      Date.now(),
      knownModels,
      requestPolicy.maxInFlight ?? null,
      failedDomainNodeIds(config.nodes, model, failedDomains),
    );
  // Passes not yet tried: the rest of this round, then every later round.
  const upcomingPasses = (roundIndex: number, pending: ReadonlyArray<{ model: string; attemptCap: number | null }>) => [
    ...pending,
    ...pendingRounds.slice(roundIndex + 1).flat(),
  ];
  modelRoundsLoop: for (let roundIndex = 0; roundIndex < pendingRounds.length; roundIndex++) {
    const pending = pendingRounds[roundIndex] ?? [];
    while (pending.length > 0) {
      const [pass] = pending.splice(pickNextModelPass(pending, requestedModel, availabilityOf), 1);
      if (!pass) continue;
      if (state.logicalAttempts >= requestPolicy.maxAttempts || state.retryShed) break modelRoundsLoop;
      const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
      if (remainingBudgetMs <= 0) {
        state.requestedModel = requestedModel;
        return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo);
      }

      const effectiveModel = pass.model;
      const passStartAttempts = state.logicalAttempts;
      const passAttemptCeiling =
        pass.attemptCap == null ? requestPolicy.maxAttempts : Math.min(requestPolicy.maxAttempts, passStartAttempts + pass.attemptCap);
      const passPolicy = passAttemptCeiling === requestPolicy.maxAttempts ? requestPolicy : { ...requestPolicy, maxAttempts: passAttemptCeiling };

      const effectiveReqDescriptor = { ...reqDescriptor, model: effectiveModel };
      state.attempted = failedDomainNodeIds(config.nodes, effectiveModel, failedDomains);
      const domainExcluded = state.attempted.size;
      const effectiveFeasibility = feasibilityForModel(effectiveModel, state.attempted);

      // If every statically reachable path for this alias is already a spent
      // failure domain, skip it without charging an attempt or reserving time.
      if (!effectiveFeasibility.reachable) {
        if (domainExcluded > 0) {
          logger.debug(
            `model-fallback skip request=${requestId} requested=${requestedModel}` +
              ` effective=${effectiveModel} reason=spent_failure_domain` +
              ` domain_excluded=${domainExcluded}`,
          );
        }
        continue;
      }

      state.requestedModel = effectiveModel;
      const futureAttemptReserve = futureAttemptReserveFor(upcomingPasses(roundIndex, pending), passAttemptCeiling);
      const effectiveLoopCtx: LoopContext = {
        ...loopCtx,
        feasibility: effectiveFeasibility,
        policy: passPolicy,
        futureAttemptReserve,
      };

      if (effectiveModel !== requestedModel || roundIndex > 0 || domainExcluded > 0) {
        logger.info(
          `model-fallback request=${requestId} round=${roundIndex + 1}/${modelPlan.length}` +
            ` requested=${requestedModel} effective=${effectiveModel}` +
            ` pass_cap=${pass.attemptCap ?? 'policy'}` +
            ` future_reserve=${futureAttemptReserve}` +
            ` domain_excluded=${domainExcluded}` +
            ` logical_attempts=${state.logicalAttempts}/${requestPolicy.maxAttempts}`,
        );
      }

      const nativeResult = await runTierLoop(effectiveLoopCtx, effectiveReqDescriptor, null);
      if (nativeResult) return deliver(nativeResult, effectiveLoopCtx);
      rememberFailedDomains(failedDomains, nodesById, state.attempted, effectiveModel);

      if (state.logicalAttempts >= requestPolicy.maxAttempts) break modelRoundsLoop;
      if (state.logicalAttempts >= passAttemptCeiling) continue;

      // Native execution may have discovered additional spent domains. Re-plan
      // the sibling reserve before protocol fallback so those aliases do not
      // keep phantom escape time inside the remainder of this pass.
      const fallbackLoopCtx: LoopContext = {
        ...effectiveLoopCtx,
        futureAttemptReserve: futureAttemptReserveFor(upcomingPasses(roundIndex, pending), passAttemptCeiling),
      };
      const fbResult = await runFallbackChain({
        loopCtx: fallbackLoopCtx,
        route,
        requestedModel: effectiveModel,
        runTierLoop,
      });
      if (fbResult) return deliver(fbResult, fallbackLoopCtx);
      rememberFailedDomains(failedDomains, nodesById, state.attempted, effectiveModel);
    }
  }

  // Last resort: the plan is spent, but an unused logical attempt remains and the
  // most recent transient failure was a native Tier 1 attempt. Retry that one key
  // once, when the remaining wall clock is at least what the failed attempt took.
  // A 429, refusal or invalid request never becomes a candidate, and a key whose
  // circuit has opened meanwhile is no longer eligible.
  const retry = state.sameNodeRetry;
  if (
    retry &&
    !state.hasRetriedSameNode &&
    !state.retryShed &&
    state.logicalAttempts < requestPolicy.maxAttempts &&
    failoverBudgetMs - (Date.now() - requestStartMs) > retry.latencyMs &&
    !request.signal?.aborted &&
    state.retrySlot?.tryAcquire() !== false
  ) {
    state.hasRetriedSameNode = true;
    state.sameNodeRetry = null;
    state.requestedModel = retry.model;
    state.attempted = new Set(config.nodes.filter((node) => node.id !== retry.nodeId).map((node) => node.id));
    const retryLoopCtx: LoopContext = { ...loopCtx, feasibility: feasibilityForModel(retry.model), futureAttemptReserve: 0 };
    logger.info(
      `same-node retry request=${requestId} node=${retry.nodeId} model=${retry.model} logical_attempts=${state.logicalAttempts}/${requestPolicy.maxAttempts}`,
    );
    const retryResult = await runTierLoop(retryLoopCtx, { ...reqDescriptor, model: retry.model }, null);
    if (retryResult) return deliver(retryResult, retryLoopCtx);
  }

  state.requestedModel = requestedModel;
  return buildExhaustedResponse(
    request,
    env,
    route,
    requestId,
    requestedModel,
    state,
    tiers,
    exposeUpstreamInfo,
    reqDescriptor,
    knownModels,
    familyFallback,
  );
}

// Hands a final response to the client, storing a cacheable success at the edge.
function deliver(response: Response, loopCtx: LoopContext): Response {
  const plan = loopCtx.edgeCachePlan;
  if (!plan || response.status !== 200) return response;
  storeEdgeCacheResponse(loopCtx.ctx, plan.keyRequest, response.clone(), plan.ttlSec, plan.stream);
  return injectMissHeader(response, loopCtx.request, loopCtx.env);
}

async function runTierLoop(
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
  }
  return null;
}
