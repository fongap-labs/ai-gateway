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

import { hasImageInput } from '../../packages/contracts/image-input.ts';
import { getProviderProfile } from '../../packages/contracts/provider-profiles.ts';
import type { ExecutionContextLike, GatewayEnv } from '../../packages/contracts/runtime.ts';
import { loadModelsConfig } from '../../src/config/models.ts';
import { modelRegistryEntry, servesModel } from '../../src/config/registry.ts';
import { getLimits } from '../../src/config/timeouts.ts';
import { getLogger, logLazy } from '../../src/observability/logger.ts';
import { admitRequestBody } from '../../src/ratelimit/body-budget.ts';
import { admitIsolateRequest, releaseIsolateRequestAfterResponse } from '../../src/ratelimit/isolate-concurrency.ts';
import { configureTier1ProbeGate } from '../../src/reliability/tier1-state.ts';
import type { RuntimeNode } from '../../src/types/node.ts';
import type { LoopContext, RouteFeasibilityResult } from '../../src/types/request.ts';
import type { TierMap } from '../../src/types/scheduler.ts';
import { injectMissHeader, matchEdgeCache, resolveEdgeCachePlan, storeEdgeCacheResponse } from './cache/edge-cache.ts';
import { isAutomaticImageToolCall, isExplicitImageToolCall, runAutomaticImageTool, runExplicitImageTool } from './chat-image-tool.ts';
import { runFallbackChain } from './fallback.ts';
import { authorizeModel } from './policy/model-authz.ts';
import { buildModelFallbackPlan, failedDomainNodeIds, pickNextModelPass, rememberFailedDomains } from './policy/model-fallback.ts';
import { evaluateRouteFeasibility } from './policy/route-feasibility.ts';
import { detectRoute, normalizePath, TIER_ORDER } from './policy/router.ts';
import { preflight as runPreflight } from './preflight.ts';
import { RetrySlot } from './reliability/retry-budget.ts';
import { hydrateSharedTier1Cooldowns } from './reliability/tier1-shared-cooldowns.ts';
import { buildBudgetExhaustedResponse, buildExhaustedResponse, gatewayError } from './response/errors.ts';
import { supportsRequest } from './scheduling/scheduler.ts';
import { makeTier1Rng } from './scheduling/tier-policy.ts';
import { readTier1Affinity, resolveTier1SessionId, shouldEvaluateAffinity } from './scheduling/tier1-affinity.ts';
import { tier1ModelAvailability } from './scheduling/tier1-scheduler.ts';
import { runTierLoop } from './tier-loop.ts';
import { preprocessChatImages } from './vision-preprocess.ts';

// A streaming attempt on a model that still has a sibling after it gives up
// after this long when the upstream stays silent. Only the last model in the
// plan may use the whole remaining request budget.
const SIBLING_HOP_CAP_MS = 45_000;

export async function handleRequest(request: Request, env: GatewayEnv, ctx: ExecutionContextLike): Promise<Response> {
  // Per-isolate reliability configuration (probe gate) must be applied before
  // the first scheduling decision of this request. getLimits caches the
  // clamped values per env object, so this costs one map lookup in steady state.
  const limits = getLimits(env);
  configureTier1ProbeGate({ v2: limits.tier1ProbeV2, timeoutMs: limits.tier1ProbeTimeoutMs });
  // AIG_REQUEST_ADMISSION: cap concurrent body-carrying requests per isolate
  // (see ratelimit/isolate-concurrency.ts). Bodyless requests — health, metrics,
  // the dashboard — pass uncounted so monitoring survives a burst. Legacy mode
  // keeps the byte-for-byte behavior: no gate is armed at all.
  const releaseConcurrency =
    limits.requestAdmission && limits.isolateMaxInFlight > 0 && request.body !== null ? admitIsolateRequest(limits.isolateMaxInFlight) : () => {};
  if (!releaseConcurrency) {
    const route = detectRoute(request.method, normalizePath(new URL(request.url).pathname));
    return gatewayError(
      request,
      env,
      route,
      503,
      'Gateway is busy with concurrent requests; retry shortly.',
      crypto.randomUUID(),
      undefined,
      { 'retry-after': '1' },
      'gateway_concurrency_exhausted',
      true,
    );
  }
  // Concurrent large bodies can exhaust the isolate's memory; past the budget the
  // client is asked to retry instead (see ratelimit/body-budget.ts).
  // A request without a body is charged nothing, whatever its Content-Length says.
  // AIG_REQUEST_ADMISSION: a body carrying no usable Content-Length (chunked
  // transfer) is charged the dedicated chunked cap instead of the full body
  // cap; its read is bounded by the same value (preflight), so the charge
  // remains a true worst case at a fraction of AIG_REQUEST_BODY_MAX_BYTES.
  const declaredLength = Number(request.headers.get('content-length'));
  const worstCaseBodyBytes =
    request.body === null
      ? 0
      : limits.requestAdmission && !(Number.isFinite(declaredLength) && declaredLength > 0)
        ? limits.chunkedBodyMaxBytes
        : limits.maxBodyBytes;
  const releaseBody = admitRequestBody(declaredLength, worstCaseBodyBytes);
  if (!releaseBody) {
    releaseConcurrency();
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
  let isConcurrencyOwnedByResponse = false;
  try {
    const response = await handleAdmittedRequest(request, env, ctx);
    const responseWithRelease = releaseIsolateRequestAfterResponse(response, releaseConcurrency);
    isConcurrencyOwnedByResponse = true;
    return responseWithRelease;
  } finally {
    releaseBody();
    if (!isConcurrencyOwnedByResponse) releaseConcurrency();
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
    bodyJson: initialBodyJson,
    rawBody: initialRawBody,
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

  let bodyJson = initialBodyJson;
  let rawBody = initialRawBody;

  // A forced, declared image tool call is an explicit instruction from an
  // authorized AGENT client; never route arbitrary chat text into paid image
  // generation, and never bypass the private Generation Center binding.
  if (route === 'openai_chat' && isExplicitImageToolCall(bodyJson)) {
    return runExplicitImageTool({
      request,
      env,
      body: bodyJson,
      auth: pre.authResult,
      knownModels,
      requestedModel,
      requestId,
      execute: (subrequest) => handleAdmittedRequest(subrequest, env, ctx),
    });
  }

  if (route === 'openai_chat' && isAutomaticImageToolCall(bodyJson)) {
    return runAutomaticImageTool({
      request,
      env,
      body: bodyJson,
      auth: pre.authResult,
      knownModels,
      requestedModel,
      requestId,
      deadlineMs: requestStartMs + failoverBudgetMs,
      executeChat: (subrequest) => handleAdmittedRequest(subrequest, env, ctx),
      executeImage: (subrequest) => handleAdmittedRequest(subrequest, env, ctx),
    });
  }

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
  // Optional visual preprocessing is separate from the model fallback graph:
  // the original Code/General alias remains responsible for answering.
  // It requires explicit configuration and authorization for the vision alias.
  const visualDelegate = loadModelsConfig(env)[requestedModel]?.policy.vision_delegate;
  if (
    route === 'openai_chat' &&
    hasImageInput(bodyJson) &&
    modelRegistryEntry(env, requestedModel).catalog.capabilities.vision !== true &&
    visualDelegate
  ) {
    const delegateModel = [...knownModels].find((model) => model.toLowerCase() === visualDelegate.toLowerCase());
    if (!delegateModel || authorizeModel(delegateModel, knownModels, pre.authResult).allowed !== true) {
      return gatewayError(
        request,
        env,
        route,
        403,
        'The configured vision preprocessor is not authorized for this key.',
        requestId,
        undefined,
        undefined,
        'gateway_vision_preprocess_unauthorized',
      );
    }
    const delegateConfig = modelRegistryEntry(env, delegateModel);
    if (
      delegateConfig.catalog.capabilities.vision !== true ||
      !config.nodes.some((node) => getProviderProfile(node.provider).imageInput && servesModel(node, delegateModel, knownModels))
    ) {
      return gatewayError(
        request,
        env,
        route,
        503,
        'No image-capable node is available for the configured vision preprocessor.',
        requestId,
        undefined,
        undefined,
        'gateway_vision_preprocess_unavailable',
      );
    }
    const visualResult = await preprocessChatImages({
      request,
      body: bodyJson,
      visionModel: delegateModel,
      remainingMs: failoverBudgetMs - (Date.now() - requestStartMs),
      // The synthesized image request is bounded and derived from this already
      // admitted body. Re-enter preflight, authorization and scheduler, but do
      // not charge the same image a second time to the isolate body gate.
      execute: (subrequest) => handleAdmittedRequest(subrequest, env, ctx),
    });
    if (!visualResult.ok) {
      return gatewayError(
        request,
        env,
        route,
        visualResult.status,
        visualResult.message,
        requestId,
        visualResult.cause ? { preprocess_failure_code: visualResult.cause } : undefined,
        undefined,
        visualResult.code,
      );
    }
    bodyJson = visualResult.body;
    rawBody = undefined; // Original image JSON must never reach a text-only node.
    if (hasImageInput(bodyJson)) {
      return gatewayError(
        request,
        env,
        route,
        400,
        'Image content could not be safely converted to visual observations.',
        requestId,
        undefined,
        undefined,
        'gateway_vision_preprocess_shape_unsupported',
      );
    }
  }
  // An image may only move to a model explicitly listed in the requested
  // model's configured fallback chain, and only if that model declares vision.
  // Never silently strip an image, infer vision from the provider name, or
  // treat an image-generation route as image understanding.
  const imageInputRequired = route !== 'openai_images' && hasImageInput(bodyJson);
  const configuredPlan =
    route === 'openai_images'
      ? [[{ model: requestedModel, attemptCap: null }]]
      : buildModelFallbackPlan(requestedModel, knownModels, requestPolicy.maxAttempts, loadModelsConfig(env));
  const modelPlan = imageInputRequired
    ? configuredPlan
        .map((round) => round.filter((pass) => modelRegistryEntry(env, pass.model).catalog.capabilities.vision === true))
        .filter((round) => round.length > 0)
    : configuredPlan;
  if (imageInputRequired && modelPlan.length === 0) {
    return gatewayError(
      request,
      env,
      route,
      400,
      'Image input is unavailable for the requested model and its explicitly configured fallback models.',
      requestId,
      undefined,
      undefined,
      'gateway_image_input_unsupported',
    );
  }
  // A vision declaration alone does not make a Provider endpoint image-capable.
  // Detect a provider-profile mismatch before scheduling so it cannot consume
  // attempts or return a misleading capacity / cooldown error.
  const visionProviderConfigured =
    !imageInputRequired ||
    modelPlan.some((round) =>
      round.some(({ model }) => config.nodes.some((node) => getProviderProfile(node.provider).imageInput && servesModel(node, model, knownModels))),
    );
  if (!visionProviderConfigured) {
    return gatewayError(
      request,
      env,
      route,
      400,
      'No image-capable Provider is configured for the requested model or its explicitly configured fallbacks.',
      requestId,
      undefined,
      undefined,
      'gateway_image_provider_unsupported',
    );
  }

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
  const triedModels = new Set<string>();
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
          logLazy(
            logger,
            'debug',
            () =>
              `model-fallback skip request=${requestId} requested=${requestedModel}` +
              ` effective=${effectiveModel} reason=spent_failure_domain` +
              ` domain_excluded=${domainExcluded}`,
          );
        }
        continue;
      }

      state.requestedModel = effectiveModel;
      // "Later" means a model this request has not tried yet. Re-check passes for
      // models already tried do not keep an earlier hop short.
      const modelKey = effectiveModel.trim().toLowerCase();
      const untriedLater = upcomingPasses(roundIndex, pending).some((later) => {
        const laterKey = later.model.trim().toLowerCase();
        return laterKey !== modelKey && !triedModels.has(laterKey);
      });
      const earlierModelTried = [...triedModels].some((tried) => tried !== modelKey);
      triedModels.add(modelKey);
      const futureAttemptReserve = futureAttemptReserveFor(upcomingPasses(roundIndex, pending), passAttemptCeiling);
      const effectiveLoopCtx: LoopContext = {
        ...loopCtx,
        feasibility: effectiveFeasibility,
        policy: passPolicy,
        attemptCapMs: untriedLater ? SIBLING_HOP_CAP_MS : null,
        takeRemainingWindow: earlierModelTried && !untriedLater,
        futureAttemptReserve,
      };

      if (effectiveModel !== requestedModel || roundIndex > 0 || domainExcluded > 0) {
        logLazy(
          logger,
          'info',
          () =>
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
    route !== 'openai_images' &&
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
    logLazy(
      logger,
      'info',
      () =>
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
  storeEdgeCacheResponse(loopCtx.ctx, plan.keyRequest, response.clone(), plan.ttlSec, plan.stream, plan.route, loopCtx.request.signal);
  return injectMissHeader(response, loopCtx.request, loopCtx.env);
}
