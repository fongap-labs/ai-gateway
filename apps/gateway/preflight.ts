import { canRouteImageGeneration } from '../../packages/contracts/image-capabilities.ts';
import { validateImageGenerationRequest } from '../../packages/contracts/image-request.ts';
import { stripReasoningDefaultMarkers } from '../../packages/contracts/reasoning-preference.ts';
import type { ExecutionContextLike, GatewayEnv } from '../../packages/contracts/runtime.ts';
import { loadAccessKeysConfig } from '../../src/config/access-keys.ts';
import { getBool } from '../../src/config/env.ts';
import { loadModelsConfig } from '../../src/config/models.ts';
import type { GatewayConfig } from '../../src/config/nodes.ts';
import { loadGatewayConfig } from '../../src/config/nodes.ts';
import { getPolicy, loadPoliciesConfig } from '../../src/config/policies.ts';
import { collectKnownModels } from '../../src/config/registry.ts';
import type { Limits } from '../../src/config/timeouts.ts';
import { getLimits, requestSizeAllowanceMs } from '../../src/config/timeouts.ts';
import { dashboardResponse } from '../../src/dashboard/pages.ts';
import { readmeStatusSvgResponse } from '../../src/dashboard/readme-status.ts';
import {
  anthropicErrorResponse,
  estimateAnthropicInputTokens,
  validateAnthropicCountTokensRequest,
  validateAnthropicMessagesRequest,
} from '../../src/protocol/anthropic.ts';
import { BodyAdmissionBudgetError, BodyTooLargeError, corsHeaders, readBodyTextWithLimit } from '../../src/protocol/http.ts';
import { validateOpenAIChatRequest } from '../../src/protocol/openai.ts';
import { validateOpenAIResponsesRequest } from '../../src/protocol/responses/index.ts';
import { admitAuthAttempt, admitKeyRequest, clearAuthFailures, hasTrackedAuthFailures, recordAuthFailure } from '../../src/ratelimit/key-rpm.ts';
import type { RuntimeNode } from '../../src/types/node.ts';
import type { PolicyConfig } from '../../src/types/policy.ts';
import type { AuthResult, RawBody, RequestDescriptor, RouteFeasibilityResult } from '../../src/types/request.ts';
import type { TierMap } from '../../src/types/scheduler.ts';
import { authorize, presentedCredentials } from './policy/auth.ts';
import { authorizeModel, filterVisibleModels, resolveClientModel } from './policy/model-authz.ts';
import { modelFallbackCandidates } from './policy/model-fallback.ts';
import { evaluateRouteFeasibility } from './policy/route-feasibility.ts';
import { acceptsHtml, detectRoute, normalizePath } from './policy/router.ts';
import { gatewayError } from './response/errors.ts';
import { jsonResponse } from './response/response-helpers.ts';

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

export async function preflight(
  request: Request,
  env: GatewayEnv,
  ctx: ExecutionContextLike,
  observeBodyBytes?: (actualBytes: number) => boolean,
): Promise<PreflightResult> {
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
  if (route === 'readiness') {
    const diag = await import('../../src/observability/diagnostic-endpoints.ts');
    return { ok: false, response: diag.readinessResponse(request, env, requestId) };
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

  if (pathname.startsWith('/oauth/')) {
    return { ok: false, response: gatewayError(request, env, route, 404, 'Not found.', requestId) };
  }

  const accessConfig = loadAccessKeysConfig(env);
  if (accessConfig.keys.length === 0) {
    return {
      ok: false,
      response: gatewayError(request, env, route, 500, 'Gateway misconfigured: no AIG_ACCESS_KEY_<GROUP> is set.', requestId),
    };
  }
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

  const authResult: AuthResult = await authorize(request, env);
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
    clearAuthFailures(await authAttemptFingerprint(request));
  }

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

  if (!hotPathGuards) await import('../../src/observability/diagnostic-endpoints.ts');
  if (route === 'health' || route === 'metrics' || route === 'models') {
    const diag = await import('../../src/observability/diagnostic-endpoints.ts');
    if ((route === 'health' || route === 'metrics') && !diag.canReadDiagnostics(env, authResult)) {
      return { ok: false, response: gatewayError(request, env, route, 403, 'This key group may not read diagnostics.', requestId) };
    }
    if (route === 'health') {
      if (requestUrl.searchParams.get('probe') === 'private-centers') {
        if (authResult.mode !== 'grouped' || (authResult.group !== 'MAX' && authResult.group !== 'ULTRA')) {
          return {
            ok: false,
            response: gatewayError(request, env, route, 403, 'Private center probe requires MAX or ULTRA diagnostics access.', requestId),
          };
        }
        const { privateCenterProbeResponse } = await import('./diagnostics/private-centers.ts');
        return { ok: false, response: await privateCenterProbeResponse(request, env, requestId) };
      }
      return { ok: false, response: diag.healthResponse(request, env, requestId, authResult) };
    }
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
    const chunked = !Number.isFinite(declaredLength) || declaredLength <= 0;
    const maxReadBytes = !observeBodyBytes && limits.requestAdmission && chunked ? limits.chunkedBodyMaxBytes : limits.maxBodyBytes;
    const text = await readBodyTextWithLimit(request, maxReadBytes, observeBodyBytes);
    bodyChars = text.length;
    bodyJson = JSON.parse(text || '{}');
    if (bodyChars > 0) rawBody = { text };
  } catch (error) {
    if (error instanceof BodyAdmissionBudgetError) {
      return {
        ok: false,
        response: gatewayError(
          request,
          env,
          route,
          503,
          error.message,
          requestId,
          undefined,
          { 'retry-after': '1' },
          'gateway_body_budget_exhausted',
          true,
        ),
      };
    }
    if (error instanceof BodyTooLargeError) {
      return { ok: false, response: gatewayError(request, env, route, 413, error.message, requestId) };
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      response: gatewayError(request, env, route, 400, `Invalid JSON request body: ${errorMessage}`, requestId),
    };
  }

  if (route === 'openai_chat' || route === 'openai_responses' || route === 'anthropic_messages') {
    const normalizedBody = stripReasoningDefaultMarkers(bodyJson);
    if (normalizedBody !== bodyJson) {
      bodyJson = normalizedBody;
      rawBody = undefined;
    }
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

  const config = loadGatewayConfig(env);
  const knownModels = collectKnownModels(config.nodes, env);
  const requestedModel = resolveClientModel(String(bodyJson.model || ''), knownModels);
  const modelsConfig = loadModelsConfig(env);
  const modelConfig = modelsConfig[requestedModel];
  const modalities = modelConfig?.catalog.modalities;
  if (route === 'openai_images') {
    if (modelConfig?.policy.visibility !== 'internal' || !modalities?.input.includes('text') || !modalities.output.includes('image')) {
      return { ok: false, response: gatewayError(request, env, route, 404, 'No authorized image generation model is configured.', requestId) };
    }
  } else if (modalities?.output.includes('image') && !modalities.output.includes('text')) {
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
          configuration_status: config.status,
          known_model_count: knownModels.size,
          ...(exposeUpstreamInfo ? { diagnostics: config.diagnostics.slice(0, 5) } : {}),
        },
      ),
    };
  }

  const callableModels = new Set(filterVisibleModels(knownModels, authResult));
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
    for (const effectiveModel of modelFallbackCandidates(requestedModel, callableModels, modelsConfig)) {
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

  const policy = getPolicy(requestedModel, modelsConfig, loadPoliciesConfig(env));
  const attemptCap = clientWantsStream ? limits.streamMaxAttempts : limits.nonStreamMaxAttempts;
  const requestPolicy = limits.requestAdmission ? { ...policy, maxAttempts: Math.min(policy.maxAttempts, attemptCap) } : policy;
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

function imageNodeCanGenerate(node: RuntimeNode, logical: string, body: Record<string, unknown>): boolean {
  return canRouteImageGeneration(node, logical, body.size ?? '1024x1024');
}
