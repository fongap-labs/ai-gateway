import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import { loadModelsConfig } from '../../../src/config/models.ts';
import { parseRetryAfterMs } from '../../../src/config/timeouts.ts';
import { anthropicErrorTypeForStatus } from '../../../src/protocol/anthropic.ts';
import { corsHeaders, shouldNotRetryHeaders, trimDiagnostic } from '../../../src/protocol/http.ts';
import { responsesErrorResponse } from '../../../src/protocol/responses/index.ts';
import type { FailureKind } from '../../../src/reliability/classify.ts';
import { KIND as FAILURE_KIND } from '../../../src/reliability/classify.ts';
import { getCooldownRemainingMs, getModelCooldownRemainingMs } from '../../../src/reliability/node-state.ts';
import { tier1BlockingWaitMs } from '../../../src/reliability/tier1-state.ts';
import { supportsRequest } from '../../../src/scheduler/scheduler.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';
import type { LoopState, RequestDescriptor } from '../../../src/types/request.ts';
import type { TierMap } from '../../../src/types/scheduler.ts';
import { modelFallbackCandidates } from '../policy/model-fallback.ts';
import { TIER_ORDER } from '../policy/router.ts';

const GATEWAY_ERROR_CODE = Object.freeze({
  FAILOVER_BUDGET_EXHAUSTED: 'gateway_failover_budget_exhausted',
  NO_DISPATCHABLE_NODE: 'gateway_no_dispatchable_node',
  ATTEMPT_BUDGET_EXHAUSTED: 'gateway_attempt_budget_exhausted',
  UPSTREAM_EXHAUSTED: 'gateway_upstream_exhausted',
  UPSTREAM_AUTH_UNAVAILABLE: 'gateway_upstream_auth_unavailable',
  UPSTREAM_MODEL_UNAVAILABLE: 'gateway_upstream_model_unavailable',
  CLIENT_DEADLINE_EXCEEDED: 'gateway_client_deadline_exceeded',
});

function responsesDiagnosticHeaders(details?: Record<string, unknown>, extraHeaders?: Record<string, string>): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(extraHeaders || {}) };
  if (details) {
    for (const [field, header] of [
      ['attempts', 'x-gateway-attempts'],
      ['dispatches', 'x-gateway-dispatches'],
      ['hedges', 'x-gateway-hedges'],
    ] as const) {
      const value = details[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        headers[header] = String(Math.trunc(value));
      }
    }
    const failureKinds = formatFailureKinds(details.failure_kinds);
    if (failureKinds) headers['x-gateway-failure-kinds'] = failureKinds;
    else if (typeof details.failure_kind === 'string' && details.failure_kind) {
      headers['x-gateway-failure-kinds'] = `${sanitizeFailureKind(details.failure_kind)}:1`;
    }
  }
  return Object.keys(headers).length ? headers : undefined;
}

function sanitizeFailureKind(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
}

function formatFailureKinds(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count > 0)
    .map(([kind, count]) => [sanitizeFailureKind(kind), Math.trunc(count as number)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([kind, count]) => `${kind}:${count}`).join(',') : null;
}

function clientErrorMessage(
  status: number,
  message: string,
  details: Record<string, unknown> | undefined,
  gatewayCode: string | null,
  retryAfterMs: number,
): string {
  const model = typeof details?.requested_model === 'string' ? trimDiagnostic(details.requested_model, 64).replace(/\s+/g, ' ') : null;
  const attempts = typeof details?.attempts === 'number' && Number.isSafeInteger(details.attempts) && details.attempts > 0 ? details.attempts : 0;
  const exhausted =
    gatewayCode === GATEWAY_ERROR_CODE.ATTEMPT_BUDGET_EXHAUSTED ||
    gatewayCode === GATEWAY_ERROR_CODE.FAILOVER_BUDGET_EXHAUSTED ||
    gatewayCode === GATEWAY_ERROR_CODE.UPSTREAM_EXHAUSTED;
  if (exhausted) {
    const subject = model || 'Model';
    const reason = status === 408 ? 'request deadline exceeded' : 'temporarily unavailable';
    const attemptsText = attempts ? ` after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}` : '';
    const retryText = retryAfterMs > 0 ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : '';
    return `${status} | ${subject} ${reason}${attemptsText}${retryText}.`;
  }
  const singleLine = trimDiagnostic(message.replace(/\s+/g, ' ').trim(), 150);
  return `${status} | ${singleLine || 'Request failed.'}`;
}

export function gatewayError(
  request: Request,
  env: GatewayEnv,
  route: string,
  status: number,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  gatewayCode: string | null = null,
  isRetryable: boolean = false,
): Response {
  const diagnosticHeaders = responsesDiagnosticHeaders(details, extraHeaders) ?? {};
  const retryable = isRetryable || status === 429;
  diagnosticHeaders['x-gateway-retryable'] = String(retryable);
  if (status === 503 && !retryable) diagnosticHeaders['x-should-retry'] = 'false';
  const kinds = details?.failure_kinds;
  const hadHeadersTimeout =
    kinds !== null && typeof kinds === 'object' && !Array.isArray(kinds) && Number((kinds as Record<string, unknown>).headers_timeout) > 0;
  const hasFamilyTimeoutEvidence = gatewayCode === GATEWAY_ERROR_CODE.ATTEMPT_BUDGET_EXHAUSTED && hadHeadersTimeout;
  const deferredFamilyRetry = hasFamilyTimeoutEvidence && parseRetryAfterMs(new Headers(extraHeaders), Date.now(), Number.MAX_SAFE_INTEGER) >= 5_000;
  if (deferredFamilyRetry) diagnosticHeaders['x-should-retry'] = 'false';
  const compactRetryEvidence = deferredFamilyRetry
    ? { failure_kinds: { headers_timeout: Math.trunc(Number((kinds as Record<string, unknown>).headers_timeout)) } }
    : {};
  if (gatewayCode) diagnosticHeaders['x-gateway-error-code'] = gatewayCode;
  if (gatewayCode === GATEWAY_ERROR_CODE.FAILOVER_BUDGET_EXHAUSTED || gatewayCode === GATEWAY_ERROR_CODE.ATTEMPT_BUDGET_EXHAUSTED) {
    diagnosticHeaders['x-gateway-budget-exhausted'] = 'true';
  }
  const retryAfterMs = parseRetryAfterMs(new Headers(extraHeaders), Date.now(), Number.MAX_SAFE_INTEGER);
  const briefMessage = clientErrorMessage(status, message, details, gatewayCode, retryAfterMs);
  const unsupportedFields =
    details?.failure_kind === 'unsupported_request_field' && Array.isArray(details.unsupported_fields)
      ? details.unsupported_fields
          .filter((field): field is string => typeof field === 'string' && field.length > 0)
          .map((field) => trimDiagnostic(field, 64))
          .slice(0, 16)
      : [];
  const validationDetails =
    status === 400 && details?.failure_kind === 'unsupported_request_field'
      ? { failure_kind: 'unsupported_request_field', unsupported_fields: unsupportedFields }
      : status === 502 && details?.failure_kind === 'conversion_not_supported'
        ? {
            failure_kind: 'conversion_not_supported',
            ...(typeof details.dispatches === 'number' && Number.isSafeInteger(details.dispatches) && details.dispatches >= 0
              ? { dispatches: details.dispatches }
              : {}),
          }
        : {};
  const exposeDetails = details !== undefined && Object.hasOwn(details, 'attempts_detail');
  const errorDetails = exposeDetails
    ? { ...details, ...(gatewayCode ? { gateway_code: gatewayCode } : {}), retryable, ...(retryAfterMs > 0 ? { retry_after_ms: retryAfterMs } : {}) }
    : gatewayCode
      ? {
          gateway_code: gatewayCode,
          retryable,
          ...(retryAfterMs > 0 ? { retry_after_ms: retryAfterMs } : {}),
          ...compactRetryEvidence,
          ...validationDetails,
          ...(typeof details?.unsupported_request_field === 'string'
            ? { unsupported_request_field: trimDiagnostic(details.unsupported_request_field, 64) }
            : {}),
        }
      : Object.keys(validationDetails).length > 0
        ? validationDetails
        : undefined;
  if (route === 'anthropic_messages' || route === 'anthropic_count_tokens') {
    return new Response(
      JSON.stringify({
        type: 'error',
        error: { type: anthropicErrorTypeForStatus(status), message: briefMessage, ...(errorDetails ? { details: errorDetails } : {}) },
      }),
      {
        status,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'cache-control': 'no-store',
          'request-id': requestId || '',
          'x-request-id': requestId || '',
          ...diagnosticHeaders,
          ...shouldNotRetryHeaders(status, isRetryable),
          ...corsHeaders(request, env),
        },
      },
    );
  }
  if (route === 'openai_responses') {
    return responsesErrorResponse(request, env, status, briefMessage, requestId, diagnosticHeaders, gatewayCode, isRetryable);
  }
  return new Response(JSON.stringify({ error: { message: briefMessage, ...(errorDetails ? { details: errorDetails } : {}) } }), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId || '',
      ...diagnosticHeaders,
      ...shouldNotRetryHeaders(status, isRetryable),
      ...corsHeaders(request, env),
    },
  });
}

export function buildBudgetExhaustedResponse(
  request: Request,
  env: GatewayEnv,
  route: string,
  requestId: string,
  requestedModel: string,
  state: LoopState,
  shouldExposeUpstreamInfo: boolean,
): Response {
  const isClientDeadlineExceeded = clientDeadlineExceeded(request);
  const status = isClientDeadlineExceeded ? 408 : 504;
  const details = {
    requested_model: requestedModel,
    attempts: state.logicalAttempts,
    dispatches: state.dispatches,
    hedges: state.hedges,
    ...(state.failureKinds && Object.keys(state.failureKinds).length ? { failure_kinds: state.failureKinds } : {}),
    ...conversionRejectedDetails(state),
    ...summarizeFailoverAttempts(state.attempts),
    ...(shouldExposeUpstreamInfo && state.attempts.length ? { attempts_detail: state.attempts } : {}),
  };
  return gatewayError(
    request,
    env,
    route,
    status,
    isClientDeadlineExceeded
      ? 'The client deadline expired; resume the task with a new deadline instead of retrying this step.'
      : `Gateway failover budget exhausted after ${state.logicalAttempts} attempt(s).`,
    requestId,
    details,
    undefined,
    isClientDeadlineExceeded ? GATEWAY_ERROR_CODE.CLIENT_DEADLINE_EXCEEDED : GATEWAY_ERROR_CODE.FAILOVER_BUDGET_EXHAUSTED,
    !isClientDeadlineExceeded,
  );
}

export function buildExhaustedResponse(
  request: Request,
  env: GatewayEnv,
  route: string,
  requestId: string,
  requestedModel: string,
  state: LoopState,
  tiers: TierMap<RuntimeNode[]>,
  shouldExposeUpstreamInfo: boolean,
  reqDescriptor: RequestDescriptor,
  knownModels?: ReadonlySet<string>,
  isRetryableFamilyExhaustion: boolean = false,
): Response {
  if (clientDeadlineExceeded(request)) {
    return buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, shouldExposeUpstreamInfo);
  }
  const last = state.attempts[state.attempts.length - 1];
  const nothingAttempted = state.attempts.length === 0;
  const knownModels_ = knownModels ?? state.knownModels;

  const now = Date.now();
  let status: number;
  let message: string;
  let retryAfterSec: number | undefined;
  let gatewayCode: string = GATEWAY_ERROR_CODE.UPSTREAM_EXHAUSTED;
  if (nothingAttempted) {
    status = 429;
    gatewayCode = GATEWAY_ERROR_CODE.NO_DISPATCHABLE_NODE;
    message = 'No eligible node can dispatch this request right now (cooldown, recovery gate, circuit state, or configured admission limit).';
    retryAfterSec = earliestBlockingRetryAfterSec(tiers, reqDescriptor, now, knownModels_);
  } else {
    status = terminalStatus(state.failureKinds) ?? (last?.status === 429 ? 429 : 502);
    message = `All attempted nodes failed for model "${requestedModel}".`;

    const failureKinds = Object.entries(state.failureKinds)
      .filter(([, count]) => (count ?? 0) > 0)
      .map(([kind]) => kind);
    if (state.dispatches === 0 && failureKinds.length === 1 && failureKinds[0] === FAILURE_KIND.AUTH) {
      gatewayCode = GATEWAY_ERROR_CODE.UPSTREAM_AUTH_UNAVAILABLE;
      message = `No upstream credential was available before dispatch for model "${requestedModel}". Check the static API Token binding in the private center.`;
    } else if (failureKinds.length === 1 && failureKinds[0] === FAILURE_KIND.MODEL_MISSING) {
      gatewayCode = GATEWAY_ERROR_CODE.UPSTREAM_MODEL_UNAVAILABLE;
      message = `Configured upstreams do not recognize the mapped model for "${requestedModel}". Check node model mapping.`;
    }

    if (isRetryableFamilyExhaustion && familyFailureSetIsRetryable(state.failureKinds, state.attempts)) {
      const originalStatus = status;
      status = 503;
      gatewayCode = GATEWAY_ERROR_CODE.ATTEMPT_BUDGET_EXHAUSTED;
      message = `Transient failures exhausted the compatible-model failover plan for "${requestedModel}". Retry shortly.`;
      const familyWaitSec = earliestFamilyBlockingRetryAfterSec(tiers, reqDescriptor, requestedModel, now, env, knownModels_);
      const hadTimeout =
        (state.failureKinds[FAILURE_KIND.HEADERS_TIMEOUT] ?? 0) > 0 || (state.failureKinds[FAILURE_KIND.FIRST_EVENT_TIMEOUT] ?? 0) > 0;
      retryAfterSec = Math.max(hadTimeout ? 5 : 1, familyWaitSec ?? 1);
      if (retryAfterSec >= 5) {
        message = `Transient failures exhausted the compatible-model failover plan for "${requestedModel}". Retry after the advertised delay.`;
      }
      state.logger.info('model-family failover plan exhausted by transient failures', {
        request_id: requestId,
        requested_model: requestedModel,
        upstream_status: originalStatus,
        client_status: status,
        retry_after_seconds: retryAfterSec,
        failure_kinds: state.failureKinds,
      });
    }

    if (status === 429 && gatewayCode !== GATEWAY_ERROR_CODE.ATTEMPT_BUDGET_EXHAUSTED) {
      retryAfterSec = earliestBlockingRetryAfterSec(tiers, reqDescriptor, now, knownModels_);
    }
  }

  const details = {
    requested_model: requestedModel,
    attempts: state.logicalAttempts,
    dispatches: state.dispatches,
    hedges: state.hedges,
    ...(state.failureKinds && Object.keys(state.failureKinds).length ? { failure_kinds: state.failureKinds } : {}),
    ...conversionRejectedDetails(state),
    ...summarizeFailoverAttempts(state.attempts),
    ...(shouldExposeUpstreamInfo && state.attempts.length ? { attempts_detail: state.attempts } : {}),
  };
  return gatewayError(
    request,
    env,
    route,
    status,
    message,
    requestId,
    details,
    retryAfterSec ? { 'retry-after': String(retryAfterSec) } : undefined,
    gatewayCode,
    !nothingAttempted && familyFailureSetIsRetryable(state.failureKinds, state.attempts),
  );
}

function clientDeadlineExceeded(request: Request): boolean {
  const raw = request.headers.get('x-gateway-deadline-ms');
  return raw !== null && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) <= Date.now();
}

function earliestBlockingRetryAfterSec(
  tiers: TierMap<RuntimeNode[]>,
  reqDescriptor: RequestDescriptor,
  now: number = Date.now(),
  knownModels?: ReadonlySet<string>,
): number | undefined {
  let minMs = Infinity;
  for (const t of TIER_ORDER) {
    for (const node of tiers[t] ?? []) {
      if (!supportsRequest(node, reqDescriptor, knownModels)) continue;
      const wait = blockingWaitMs(node, reqDescriptor.model, now);
      if (wait < minMs) minMs = wait;
    }
  }
  if (!Number.isFinite(minMs)) return undefined;
  return Math.max(1, Math.ceil(minMs / 1000));
}

function earliestFamilyBlockingRetryAfterSec(
  tiers: TierMap<RuntimeNode[]>,
  reqDescriptor: RequestDescriptor,
  requestedModel: string,
  now: number,
  env: GatewayEnv,
  knownModels?: ReadonlySet<string>,
): number | undefined {
  const models = knownModels ? modelFallbackCandidates(requestedModel, knownModels, loadModelsConfig(env)) : [requestedModel];
  let minSec = Infinity;
  for (const model of models) {
    const wait = earliestBlockingRetryAfterSec(tiers, { ...reqDescriptor, model }, now, knownModels);
    if (wait !== undefined && wait < minSec) minSec = wait;
  }
  return Number.isFinite(minSec) ? minSec : undefined;
}

function blockingWaitMs(node: RuntimeNode, requestedModel: string, now: number): number {
  if (node.tier === 'tier-1') return tier1BlockingWaitMs(node, requestedModel, now);
  const nodeCd = getCooldownRemainingMs(node.id, now);
  if (nodeCd > 0) return nodeCd;
  const modelCd = getModelCooldownRemainingMs(node.id, requestedModel, now);
  if (modelCd > 0) return modelCd;
  return Infinity;
}

export function buildClientErrorResponse(
  request: Request,
  env: GatewayEnv,
  route: string,
  requestId: string,
  requestedModel: string,
  status: number,
  errorText: string | Uint8Array,
  state: LoopState,
  shouldExposeUpstreamInfo: boolean,
): Response {
  const genericDetail = `Upstream rejected the request with HTTP ${status}.`;
  const detail = shouldExposeUpstreamInfo ? extractErrorMessage(errorText) || genericDetail : genericDetail;
  return gatewayError(request, env, route, status, detail, requestId, {
    requested_model: requestedModel,
    attempts: state.logicalAttempts,
    dispatches: state.dispatches,
    hedges: state.hedges,
    ...(state.failureKinds && Object.keys(state.failureKinds).length ? { failure_kinds: state.failureKinds } : {}),
    ...(shouldExposeUpstreamInfo && state.attempts.length ? { attempts_detail: state.attempts.slice(-1) } : {}),
  });
}

function extractErrorMessage(text: string | Uint8Array | null | undefined): string {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const json = JSON.parse(raw);
    return json?.error?.message || json?.message || trimDiagnostic(raw, 300);
  } catch {
    return trimDiagnostic(raw, 300);
  }
}

function conversionRejectedDetails(state: LoopState): { conversion_rejected?: number } {
  return state.conversionRejections ? { conversion_rejected: state.conversionRejections } : {};
}

function familyFailureSetIsRetryable(
  failureKinds?: Partial<Record<FailureKind, number>>,
  attempts: ReadonlyArray<Record<string, unknown>> = [],
): boolean {
  const observed = Object.entries(failureKinds || {}).filter(([, count]) => (count || 0) > 0);
  if (observed.length === 0) return false;

  const retryableKinds = new Set<string>([
    FAILURE_KIND.RATE_LIMIT,
    FAILURE_KIND.RATE_LIMIT_GLOBAL,
    FAILURE_KIND.SERVER,
    FAILURE_KIND.NETWORK,
    FAILURE_KIND.HEADERS_TIMEOUT,
    FAILURE_KIND.FIRST_EVENT_TIMEOUT,
    FAILURE_KIND.STREAM_INTERRUPTED,
  ]);
  const transient = observed.some(([kind]) => retryableKinds.has(kind));
  if (!transient) return false;
  const routeLocal422Count = attempts.filter(
    (attempt) => attempt.dispatched === true && attempt.kind === FAILURE_KIND.CLIENT && attempt.status === 422,
  ).length;
  return observed.every(([kind, count]) => retryableKinds.has(kind) || (kind === FAILURE_KIND.CLIENT && Number(count) <= routeLocal422Count));
}

function terminalStatusForKind(kind: string): 429 | 502 | 504 {
  if (kind === FAILURE_KIND.RATE_LIMIT || kind === FAILURE_KIND.RATE_LIMIT_GLOBAL) return 429;
  if (kind === FAILURE_KIND.HEADERS_TIMEOUT || kind === FAILURE_KIND.FIRST_EVENT_TIMEOUT) return 504;
  return 502;
}

export function terminalStatus(failureKinds?: Partial<Record<FailureKind, number>>): number | null {
  const counts: Record<429 | 502 | 504, number> = { 429: 0, 502: 0, 504: 0 };
  for (const [kind, rawCount] of Object.entries(failureKinds || {})) {
    const count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : 0;
    if (count === 0) continue;
    counts[terminalStatusForKind(kind)] += count;
  }

  const total = counts[429] + counts[502] + counts[504];
  if (total === 0) return null;

  let bestStatus: 429 | 502 | 504 = 504;
  let bestCount = counts[504];
  for (const status of [502, 429] as const) {
    if (counts[status] > bestCount) {
      bestStatus = status;
      bestCount = counts[status];
    }
  }
  return bestStatus;
}

export function summarizeFailoverAttempts(attempts: ReadonlyArray<Record<string, unknown>>): {
  failover_summary?: {
    model_switches: number;
    distinct_models: number;
    tier1_dispatches: number;
    tier2_dispatches: number;
    other_dispatches: number;
    truncated: boolean;
  };
} {
  const tail = attempts.slice(-64);
  let previous: string | null = null;
  let switches = 0;
  let tier1 = 0;
  let tier2 = 0;
  let other = 0;
  const models = new Set<string>();
  for (const attempt of tail) {
    if (attempt.dispatched === false) continue;
    const model = typeof attempt.effective_model === 'string' && attempt.effective_model ? attempt.effective_model : null;
    if (model) {
      if (previous !== null && previous !== model) switches++;
      previous = model;
      models.add(model);
    }
    if (attempt.tier === 'tier-1') tier1++;
    else if (attempt.tier === 'tier-2') tier2++;
    else other++;
  }
  if (!tier1 && !tier2 && !other) return {};
  return {
    failover_summary: {
      model_switches: switches,
      distinct_models: models.size,
      tier1_dispatches: tier1,
      tier2_dispatches: tier2,
      other_dispatches: other,
      truncated: attempts.length > tail.length,
    },
  };
}
