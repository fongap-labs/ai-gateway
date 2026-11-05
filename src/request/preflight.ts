// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { loadAccessKeysConfig } from '../config/access-keys.ts';
import { getBool } from '../config/env.ts';
import { loadModelsConfig } from '../config/models.ts';
import type { GatewayConfig } from '../config/nodes.ts';
import { loadGatewayConfig } from '../config/nodes.ts';
import { getPolicy, loadPoliciesConfig } from '../config/policies.ts';
import { collectKnownModels } from '../config/registry.ts';
import type { Limits } from '../config/timeouts.ts';
import { getLimits, requestSizeAllowanceMs } from '../config/timeouts.ts';
import { dashboardResponse } from '../dashboard/pages.ts';
import { readmeStatusSvgResponse } from '../dashboard/readme-status.ts';
import { handleOAuthRoute } from '../oauth/routes.ts';
import {
  anthropicErrorResponse,
  estimateAnthropicInputTokens,
  validateAnthropicCountTokensRequest,
  validateAnthropicMessagesRequest,
} from '../protocol/anthropic.ts';
import { BodyTooLargeError, corsHeaders, readBodyTextWithLimit } from '../protocol/http.ts';
import { validateImageGenerationRequest } from '../protocol/image.ts';
import { validateOpenAIChatRequest } from '../protocol/openai.ts';
import { validateOpenAIResponsesRequest } from '../protocol/responses/index.ts';
import { getProviderAdapter } from '../providers/registry.ts';
import { admitAuthAttempt, admitKeyRequest, clearAuthFailures, hasTrackedAuthFailures, recordAuthFailure } from '../ratelimit/key-rpm.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { PolicyConfig } from '../types/policy.ts';
import type { AuthResult, RawBody, RequestDescriptor, RouteFeasibilityResult } from '../types/request.ts';
import type { ExecutionContextLike, GatewayEnv } from '../types/runtime.ts';
import type { TierMap } from '../types/scheduler.ts';
import { authorize, authorizeDeploymentHealth, isDeploymentHealthRoute, presentedCredentials } from './auth.ts';
import { gatewayError } from './errors.ts';
import { authorizeModel, filterVisibleModels, resolveClientModel } from './model-authz.ts';
import { modelFallbackCandidates } from './model-fallback.ts';
import { jsonResponse } from './response-helpers.ts';
import { evaluateRouteFeasibility } from './route-feasibility.ts';
import { acceptsHtml, detectRoute, normalizePath } from './router.ts';

const ROUTE_PROTOCOL_SURFACE = Object.freeze({
  openai_chat: { protocol: 'openai', surface: 'chat_completions' },
  openai_responses: { protocol: 'openai', surface: 'responses' },
  openai_images: { protocol: 'openai', surface: 'images_generations' },
  anthropic_messages: { protocol: 'anthropic', surface: 'messages' },
} as const);

export function getRouteProtocolSurface(route: keyof typeof ROUTE_PROTOCOL_SURFACE): {
  protocol: 'openai' | 'anthropic';
  surface: 'chat_completions' | 'responses' | 'messages' | 'images_generations';
} {
  return ROUTE_PROTOCOL_SURFACE[route];
}

export type PreflightTerminal = { ok: false; response: Response };
export type PreflightOk = {
  ok: true;
  request: Request;
  env: GatewayEnv;
  ctx: ExecutionContextLike;
  requestId: string;
  requestStartMs: number;
  route: string;
  requestedModel: string;
  clientWantsStream: boolean;
  fakeStream: boolean;
  bodyJson: Record<string, unknown>;
  /**
   * Original JSON text reused when dispatch needs no model/stream mutation,
   * avoiding a second full JSON.stringify. dispatch.ts releases it once the
   * first outbound body is built or sent, so a large body does not stay alive
   * during streaming or fallback.
   */
  rawBody?: RawBody;
  limits: Limits;
  exposeUpstreamInfo: boolean;
  authResult: AuthResult;
  requestDescriptor: RequestDescriptor;
  config: GatewayConfig;
  tiers: TierMap<RuntimeNode[]>;
  policy: PolicyConfig;
  failoverBudgetMs: number;
  knownModels: Set<string>;
  feasibility: RouteFeasibilityResult;
};
export type PreflightResult = PreflightTerminal | PreflightOk;

// Fingerprint for the failed-authorization window: 'ANON' when no credential is
// presented, otherwise the first 16 hex digits of the SHA-256 of the presented
// credentials. The plaintext credential is never stored or logged.
async function authAttemptFingerprint(request: Request): Promise<string> {
  const credentials = presentedCredentials(request);
  if (credentials.length === 0) return 'ANON';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credentials.join('\n'))));
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rateLimitedResponse(request: Request, env: GatewayEnv, retryAfterSec: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: 'rate_limit_error',
        code,
        retry_after_seconds: retryAfterSec,
      },
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(retryAfterSec),
        ...(corsHeaders(request, env) || {}),
      },
    },
  );
}

export async function preflight(request: Request, env: GatewayEnv, ctx: ExecutionContextLike): Promise<PreflightResult> {
  const requestId = crypto.randomUUID();
  const requestUrl = new URL(request.url);
  const pathname = normalizePath(requestUrl.pathname);
  const route = detectRoute(request.method, pathname);
  const requestStartMs = Date.now();
  const exposeUpstreamInfo =
    String(env?.AIG_SHOULD_EXPOSE_UPSTREAM ?? '')
      .trim()
      .toLowerCase() === 'true';

  if (request.method === 'OPTIONS') {
    return { ok: false, response: new Response(null, { status: 204, headers: corsHeaders(request, env) }) };
  }
  const isPublicDashboard = getBool(env, 'AIG_PUBLIC_DASHBOARD', true);
  if (request.method === 'GET' && pathname === '/' && acceptsHtml(request)) {
    if (!isPublicDashboard) return { ok: false, response: gatewayError(request, env, route, 404, 'Not found.', requestId) };
    return { ok: false, response: await dashboardResponse(request, env) };
  }
  if (request.method === 'GET' && pathname === '/readme-status.svg') {
    if (!isPublicDashboard) return { ok: false, response: gatewayError(request, env, route, 404, 'Not found.', requestId) };
    return { ok: false, response: await readmeStatusSvgResponse(env) };
  }

  // OAuth onboarding routes. Handled before the access-key presence check so
  // the browser redirect callback (which carries no gateway key) can complete.
  // /oauth/start requires a gateway key (checked inside the handler); the
  // callback and paste routes are authorized by their single-use D1 state.
  if ((request.method === 'GET' || request.method === 'POST') && pathname.startsWith('/oauth/')) {
    if (!getBool(env, 'AIG_IS_SUBSCRIPTION_ENABLED', true)) {
      return { ok: false, response: gatewayError(request, env, route, 404, 'Not found.', requestId) };
    }
    const config = loadGatewayConfig(env);
    const oauthResponse = await handleOAuthRoute(
      request,
      env,
      {
        tier2Nodes: (config.tiers[2] || []).map((node) => ({
          id: node.id,
          provider: node.provider,
          auth: node.auth,
        })),
        // A closure, because Workers reject waitUntil called detached from its context.
        waitUntil: ctx.waitUntil ? (promise) => ctx.waitUntil?.(promise) : undefined,
      },
      pathname,
    );
    return { ok: false, response: oauthResponse };
  }

  const accessConfig = loadAccessKeysConfig(env);
  if (accessConfig.keys.length === 0) {
    return {
      ok: false,
      response: gatewayError(request, env, route, 500, 'Gateway misconfigured: no AIG_ACCESS_KEY_<GROUP> is set.', requestId),
    };
  }
  // Failed-authorization throttle. It is checked before any credential is
  // verified, and only failed attempts are charged, so valid traffic never
  // consumes the budget.
  // AIG_HOT_PATH_GUARDS: the fingerprint is the SHA-256 of the presented
  // credential, and the throttle state is keyed BY it. While no failed attempt
  // is tracked (the healthy steady state for most isolates), both the admit
  // check and the success clear are no-ops, so the hash is computed lazily: on
  // this isolate's first failure, or when there is tracked state to consult.
  // Legacy mode hashes on every request byte-for-byte.
  const hotPathGuards = getLimits(env).hotPathGuards;
  let authFingerprint: string | null = !hotPathGuards || hasTrackedAuthFailures() ? await authAttemptFingerprint(request) : null;
  const authAttemptVerdict = admitAuthAttempt(authFingerprint ?? '', getLimits(env).authAttemptRpm);
  if (authAttemptVerdict.ok === false) {
    return {
      ok: false,
      response: rateLimitedResponse(
        request,
        env,
        authAttemptVerdict.retryAfterSec,
        'gateway_auth_throttled',
        `Too many failed gateway authorization attempts. Retry after ${authAttemptVerdict.retryAfterSec}s.`,
      ),
    };
  }

  let authResult: AuthResult = await authorize(request, env);
  const deploymentHealthRoute = isDeploymentHealthRoute(route);
  if (!authResult.authorized && deploymentHealthRoute) {
    authResult = (await authorizeDeploymentHealth(request, env)) ?? authResult;
  }
  if (!authResult.authorized) {
    authFingerprint ??= await authAttemptFingerprint(request);
    recordAuthFailure(authFingerprint);
    return {
      ok: false,
      response: gatewayError(request, env, route, 401, 'Unauthorized: gateway access key is invalid or missing.', requestId),
    };
  }
  if (authFingerprint !== null) {
    clearAuthFailures(authFingerprint);
  } else if (hasTrackedAuthFailures()) {
    // A concurrent failure was charged while this request was authorizing;
    // keep the legacy "success clears my fingerprint" semantics in that window.
    clearAuthFailures(await authAttemptFingerprint(request));
  }

  // Local diagnostics/model-list routes carry no upstream cost and do not
  // consume the client-key RPM budget.
  if (route !== 'health' && route !== 'metrics' && route !== 'models' && route !== 'anthropic_count_tokens') {
    const limits = getLimits(env);
    const fingerprint = ('group' in authResult ? authResult.group : null) || 'ANON';
    const verdict = admitKeyRequest(fingerprint, limits.gatewayKeyRpm);
    if (verdict.ok === false) {
      return {
        ok: false,
        response: rateLimitedResponse(
          request,
          env,
          verdict.retryAfterSec,
          'gateway_key_rpm',
          `Gateway access-key RPM cap exceeded. Retry after ${verdict.retryAfterSec}s.`,
        ),
      };
    }
  }

  // AIG_HOT_PATH_GUARDS: the diagnostics bundle (dashboard / metrics views) is
  // loaded only by the routes that render it; legacy mode keeps the historical
  // unconditional import, which evaluates the module on every request path.
  if (!hotPathGuards) await import('../observability/diagnostic-endpoints.ts');
  if (route === 'health' || route === 'metrics' || route === 'models') {
    const diag = await import('../observability/diagnostic-endpoints.ts');
    if ((route === 'health' || route === 'metrics') && !diag.canReadDiagnostics(env, authResult)) {
      return { ok: false, response: gatewayError(request, env, route, 403, 'This key group may not read diagnostics.', requestId) };
    }
    if (route === 'health') return { ok: false, response: diag.healthResponse(request, env, requestId, authResult) };
    if (route === 'metrics') return { ok: false, response: diag.metricsResponse(request, env, requestId) };
    return { ok: false, response: diag.modelsListResponse(request, env, requestId, authResult) };
  }
  switch (route) {
    case 'openai_chat':
    case 'anthropic_messages':
    case 'anthropic_count_tokens':
    case 'openai_responses':
    case 'openai_images':
      break;
    default:
      return { ok: false, response: gatewayError(request, env, route, 404, 'Route not found.', requestId) };
  }

  // Private image tooling must run with the dedicated AGENT gateway key.
  // visibility:"internal" only hides discovery; it is not authentication.
  if (route === 'openai_images' && (authResult.mode !== 'grouped' || authResult.group !== 'AGENT')) {
    return { ok: false, response: gatewayError(request, env, route, 403, 'Image generation requires an authorized backend tool.', requestId) };
  }

  const limits = getLimits(env);
  const deadlineHeader = request.headers.get('x-gateway-deadline-ms');
  const clientDeadlineMs = deadlineHeader === null ? null : Number(deadlineHeader);
  if (deadlineHeader !== null && (!/^\d+$/.test(deadlineHeader) || !Number.isSafeInteger(clientDeadlineMs) || (clientDeadlineMs ?? 0) <= 0)) {
    return {
      ok: false,
      response: gatewayError(request, env, route, 400, 'X-Gateway-Deadline-Ms must be a positive Unix timestamp in milliseconds.', requestId),
    };
  }
  if (clientDeadlineMs !== null && clientDeadlineMs <= Date.now()) {
    return {
      ok: false,
      response: gatewayError(
        request,
        env,
        route,
        408,
        'The client deadline has expired.',
        requestId,
        undefined,
        undefined,
        'gateway_client_deadline_exceeded',
      ),
    };
  }
  let bodyJson: Record<string, unknown>;
  let rawBody: RawBody | undefined;
  let bodyChars = 0;
  try {
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        response: gatewayError(request, env, route, 415, 'This endpoint requires Content-Type: application/json.', requestId),
      };
    }
    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > limits.maxBodyBytes) {
      return { ok: false, response: gatewayError(request, env, route, 413, 'Request body exceeds limit.', requestId) };
    }
    // AIG_REQUEST_ADMISSION: a body carrying no usable Content-Length (chunked
    // transfer) is read under the dedicated chunked cap — the same value it was
    // admitted against in handler.ts — instead of the full body cap. Bodies
    // WITH a Content-Length keep the full read ceiling.
    const chunked = !Number.isFinite(declaredLength) || declaredLength <= 0;
    const text = await readBodyTextWithLimit(request, limits.requestAdmission && chunked ? limits.chunkedBodyMaxBytes : limits.maxBodyBytes);
    bodyChars = text.length;
    bodyJson = JSON.parse(text || '{}');
    if (bodyChars > 0) rawBody = { text };
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { ok: false, response: gatewayError(request, env, route, 413, error.message, requestId) };
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      response: gatewayError(request, env, route, 400, `Invalid JSON request body: ${errorMessage}`, requestId),
    };
  }

  if (route === 'anthropic_count_tokens') {
    const mode = String(env?.AIG_ANTHROPIC_COUNT_MODE || 'approximate').toLowerCase();
    if (!['approximate', 'disabled'].includes(mode)) {
      return {
        ok: false,
        response: anthropicErrorResponse(request, env, 500, 'AIG_ANTHROPIC_COUNT_MODE must be approximate or disabled.', requestId),
      };
    }
    if (mode === 'disabled') {
      return { ok: false, response: anthropicErrorResponse(request, env, 404, 'Token counting is disabled on this gateway.', requestId) };
    }
    const validationError = validateAnthropicCountTokensRequest(bodyJson);
    if (validationError) {
      return { ok: false, response: anthropicErrorResponse(request, env, 400, validationError, requestId) };
    }
    return {
      ok: false,
      response: jsonResponse(200, { input_tokens: estimateAnthropicInputTokens(bodyJson) }, env, request, { 'x-request-id': requestId }),
    };
  }

  let validationError: string | null | undefined;
  if (route === 'openai_images') validationError = validateImageGenerationRequest(bodyJson);
  else if (route === 'openai_responses') validationError = validateOpenAIResponsesRequest(bodyJson);
  else if (route === 'anthropic_messages') validationError = validateAnthropicMessagesRequest(bodyJson);
  else validationError = validateOpenAIChatRequest(bodyJson);
  if (validationError) {
    return { ok: false, response: gatewayError(request, env, route, 400, validationError, requestId) };
  }

  const clientWantsStream = bodyJson.stream === true;
  const fakeStream =
    route === 'openai_chat' &&
    String(env?.AIG_HAS_STREAM_GUARD ?? '')
      .trim()
      .toLowerCase() === 'true' &&
    !clientWantsStream;

  const gatewayConfigForAuth = loadGatewayConfig(env);
  const knownModels = collectKnownModels(gatewayConfigForAuth.nodes, env);
  // Client spelling is normalized onto the configured catalog entry before
  // authorization and routing: context-length tags (`...[1m]`) are dropped and
  // casing differences collapse onto the configured spelling. Unknown models
  // keep their raw spelling so the fail-closed 404/403 paths are unchanged.
  const requestedModel = resolveClientModel(String(bodyJson.model || ''), knownModels);
  const modelConfig = loadModelsConfig(env)[requestedModel];
  const modalities = modelConfig?.catalog.modalities;
  if (route === 'openai_images') {
    // Explicitly opt in to the internal image contract. A chat-only alias or
    // an unclassified legacy Image-Creator mapping cannot enter image dispatch.
    if (modelConfig?.policy.visibility !== 'internal' || !modalities?.input.includes('text') || !modalities.output.includes('image')) {
      return { ok: false, response: gatewayError(request, env, route, 404, 'No authorized image generation model is configured.', requestId) };
    }
  } else if (modalities?.output.includes('image') && !modalities.output.includes('text')) {
    // Do not waste eleven chat dispatches on a model declared as image-only.
    return { ok: false, response: gatewayError(request, env, route, 400, 'This model requires the image generation tool.', requestId) };
  }
  const modelAuthz = authorizeModel(requestedModel, knownModels, authResult);
  if (modelAuthz.allowed === false) {
    const denyStatus = modelAuthz.status;
    return {
      ok: false,
      response: gatewayError(
        request,
        env,
        route,
        denyStatus,
        denyStatus === 403 ? 'Forbidden: the provided key is not permitted to use this model.' : 'Model not found for this key.',
        requestId,
        {
          configuration_status: gatewayConfigForAuth.status,
          known_model_count: knownModels.size,
          ...(exposeUpstreamInfo ? { diagnostics: gatewayConfigForAuth.diagnostics.slice(0, 5) } : {}),
        },
      ),
    };
  }

  const callableModels = new Set(filterVisibleModels(knownModels, authResult));
  const config = loadGatewayConfig(env);
  if (!config.ready) {
    return {
      ok: false,
      response: gatewayError(
        request,
        env,
        route,
        500,
        'Gateway misconfigured: no usable node configuration. Check TIER*_NODES_* and TIER*_CREDENTIALS_*.',
        requestId,
        { configuration_status: config.status, ...(exposeUpstreamInfo ? { diagnostics: config.diagnostics.slice(0, 5) } : {}) },
      ),
    };
  }

  const tiers: TierMap<RuntimeNode[]> =
    route === 'openai_images'
      ? {
          1: config.tiers[1].filter((node) => imageNodeCanGenerate(node, requestedModel, bodyJson)),
          2: config.tiers[2].filter((node) => imageNodeCanGenerate(node, requestedModel, bodyJson)),
          3: config.tiers[3].filter((node) => imageNodeCanGenerate(node, requestedModel, bodyJson)),
        }
      : config.tiers;
  const requestDescriptor: RequestDescriptor = {
    route: route as 'openai_chat' | 'openai_responses' | 'anthropic_messages' | 'openai_images',
    model: requestedModel,
    ...ROUTE_PROTOCOL_SURFACE[route as keyof typeof ROUTE_PROTOCOL_SURFACE],
    bodyChars,
  };

  const feasibility = evaluateRouteFeasibility({
    route,
    requestedModel,
    requestDescriptor,
    tiers,
    knownModels: callableModels,
    env,
  });
  let familyReachable = feasibility.reachable;
  if (!familyReachable && route !== 'openai_images') {
    for (const effectiveModel of modelFallbackCandidates(requestedModel, callableModels)) {
      if (effectiveModel === requestedModel) continue;
      const effectiveDescriptor = { ...requestDescriptor, model: effectiveModel };
      const candidateFeasibility = evaluateRouteFeasibility({
        route,
        requestedModel: effectiveModel,
        requestDescriptor: effectiveDescriptor,
        tiers,
        knownModels: callableModels,
        env,
      });
      if (candidateFeasibility.reachable) {
        familyReachable = true;
        break;
      }
    }
  }
  if (!familyReachable) {
    return {
      ok: false,
      response: gatewayError(
        request,
        env,
        route,
        404,
        `No configured route can serve model "${requestedModel}" for client protocol "${requestDescriptor.protocol}" surface "${requestDescriptor.surface}", including internal compatible model fallback.`,
        requestId,
      ),
    };
  }

  const policy = getPolicy(requestedModel, loadModelsConfig(env), loadPoliciesConfig(env));
  // AIG_REQUEST_ADMISSION: cap the request-wide logical attempts per streaming
  // mode. A wide failover plan fans out into the whole node pool — every attempt
  // bills at least one upstream dispatch — and a streaming attempt can never
  // retry after the client stream is committed, so the leverage of attempt 4+
  // is paid for by every caller. Operators re-widen with
  // AIG_STREAM_MAX_ATTEMPTS / AIG_NONSTREAM_MAX_ATTEMPTS.
  const attemptCap = clientWantsStream ? limits.streamMaxAttempts : limits.nonStreamMaxAttempts;
  const requestPolicy = limits.requestAdmission ? { ...policy, maxAttempts: Math.min(policy.maxAttempts, attemptCap) } : policy;
  // A large prompt needs proportionally more wall-clock time for prefill, so the
  // request budget grows with its size instead of timing out healthy upstreams.
  const serverBudgetMs = (policy.failoverBudgetMs ?? limits.failoverBudgetMs) + requestSizeAllowanceMs(bodyChars);
  const failoverBudgetMs = clientDeadlineMs === null ? serverBudgetMs : Math.min(serverBudgetMs, clientDeadlineMs - requestStartMs);
  return {
    ok: true,
    request,
    env,
    ctx,
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
    authResult,
    requestDescriptor,
    config,
    tiers,
    policy: requestPolicy,
    failoverBudgetMs,
    knownModels: callableModels,
    feasibility,
  };
}

// Eligibility for the image surface is narrower than a provider's general
// wire capability. It requires explicit model mapping and a real API-key node;
// a wildcard or a Codex/Code Assist subscription cannot claim image support.
function imageNodeCanGenerate(node: RuntimeNode, logical: string, body: Record<string, unknown>): boolean {
  if (node.auth === 'oauth' || !Object.hasOwn(node.models, logical) || !node.surfaces.includes('images_generations')) return false;
  const adapter = getProviderAdapter(node.provider).image;
  if (!adapter) return false;
  try {
    return (
      adapter.prepare(node.baseUrl, node.models[logical] as string, {
        prompt: String(body.prompt),
        size: (body.size ?? '1024x1024') as '1024x1024' | '1024x1536' | '1536x1024',
      }) !== null
    );
  } catch {
    return false;
  }
}
