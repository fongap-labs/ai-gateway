// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Gateway error-response builders. Every terminal client-facing error goes
// through here so protocol shape, topology hiding, Retry-After and
// x-should-retry semantics stay consistent across routes.
//
// Topology policy: by default terminal errors expose only gateway-owned
// aggregate diagnostics (requested model / attempt counts where that protocol
// shape supports them). Raw upstream error messages and per-attempt internal
// details stay hidden. Both are exposed only when the caller passes
// `exposeUpstreamInfo` (AIG_SHOULD_EXPOSE_UPSTREAM=true).

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

/** The client receives one readable reason; detailed failure telemetry belongs in headers/logs. */
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
    const attemptsText = attempts ? ` after ${attempts} attempts` : '';
    const retryText = retryAfterMs > 0 ? `; retry after ${Math.ceil(retryAfterMs / 1000)}s` : '';
    return `${status} | ${subject} ${reason}${attemptsText}${retryText}.`;
  }
  // Preserve a useful diagnostic for request errors while preventing multi-line
  // Provider/internal messages from taking over the client's failure display.
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
  const retryable = isRetryable || status === 429 || status === 503;
  diagnosticHeaders['x-gateway-retryable'] = String(retryable);
  // SDKs must not immediately replay an already exhausted model-family
  // request against a pool whose earliest recovery is still many seconds
  // away. Retry-After remains the eventual recovery hint; this separate
  // header only disables blind automatic retries of the entire request.
  // Limit this override to mixed timeout/rate-limit failures. Pure 429 exhaustion
  // retains its established SDK Retry-After contract and remains retryable.
  // It does NOT change Key eligibility, circuit state or Provider quota.
  const kinds = details?.failure_kinds;
  const hadHeadersTimeout =
    kinds !== null && typeof kinds === 'object' && !Array.isArray(kinds) && Number((kinds as Record<string, unknown>).headers_timeout) > 0;
  const deferredFamilyRetry =
    gatewayCode === GATEWAY_ERROR_CODE.ATTEMPT_BUDGET_EXHAUSTED &&
    hadHeadersTimeout &&
    parseRetryAfterMs(new Headers(extraHeaders), Date.now(), Number.MAX_SAFE_INTEGER) >= 5_000;
  if (deferredFamilyRetry) diagnosticHeaders['x-should-retry'] = 'false';
  if (gatewayCode) diagnosticHeaders['x-gateway-error-code'] = gatewayCode;
  if (gatewayCode === GATEWAY_ERROR_CODE.FAILOVER_BUDGET_EXHAUSTED || gatewayCode === GATEWAY_ERROR_CODE.ATTEMPT_BUDGET_EXHAUSTED) {
    diagnosticHeaders['x-gateway-budget-exhausted'] = 'true';
  }
  const retryAfterMs = parseRetryAfterMs(new Headers(extraHeaders), Date.now(), Number.MAX_SAFE_INTEGER);
  const briefMessage = clientErrorMessage(status, message, details, gatewayCode, retryAfterMs);
  // Never serialize the full retry/failover graph into a standard error body.
  // Explicit upstream diagnostics remain opt-in, preserving forensic access.
  // The stable gateway code, counters, classifications, request ID and retry
  // timing are available in response headers for clients and observability.
  const exposeDetails = details !== undefined && Object.hasOwn(details, 'attempts_detail');
  const errorDetails = exposeDetails
    ? { ...details, ...(gatewayCode ? { gateway_code: gatewayCode } : {}), retryable, ...(retryAfterMs > 0 ? { retry_after_ms: retryAfterMs } : {}) }
    : gatewayCode
      ? { gateway_code: gatewayCode, retryable, ...(retryAfterMs > 0 ? { retry_after_ms: retryAfterMs } : {}) }
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

    // Credential admission can fail before dispatch. Keep the error
    // non-retryable without exposing node identities.
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
      // A timeout may win the terminal-status tie even when several physical
      // candidates are cooling down after 429. Preserve the family's real
      // blocking window instead of telling the caller to retry after 1s.
      const sawRateLimit = (state.failureKinds[FAILURE_KIND.RATE_LIMIT] ?? 0) > 0 || (state.failureKinds[FAILURE_KIND.RATE_LIMIT_GLOBAL] ?? 0) > 0;
      retryAfterSec = sawRateLimit ? (earliestFamilyBlockingRetryAfterSec(tiers, reqDescriptor, requestedModel, now, env, knownModels_) ?? 1) : 1;
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

    if (status === 429) {
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
  // Fallback membership is explicitly configured, never inferred from a
  // logical model's name. The cooldown hint must inspect those aliases too.
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
  const attemptsDetail = shouldExposeUpstreamInfo && state.attempts.length ? { attempts_detail: state.attempts.slice(-1) } : {};
  if (route === 'anthropic_messages') {
    return new Response(
      JSON.stringify({
        type: 'error',
        error: { type: anthropicErrorTypeForStatus(status), message: detail },
      }),
      {
        status,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'cache-control': 'no-store',
          'request-id': requestId,
          'x-request-id': requestId,
          ...shouldNotRetryHeaders(status),
          ...corsHeaders(request, env),
        },
      },
    );
  }
  if (route === 'openai_responses') {
    return responsesErrorResponse(
      request,
      env,
      status,
      detail,
      requestId,
      responsesDiagnosticHeaders({
        requested_model: requestedModel,
        attempts: state.logicalAttempts,
        dispatches: state.dispatches,
        hedges: state.hedges,
      }),
    );
  }
  return new Response(
    JSON.stringify({
      error: {
        message: detail,
        details: {
          requested_model: requestedModel,
          attempts: state.logicalAttempts,
          dispatches: state.dispatches,
          hedges: state.hedges,
          ...(state.failureKinds && Object.keys(state.failureKinds).length ? { failure_kinds: state.failureKinds } : {}),
          ...summarizeFailoverAttempts(state.attempts),
          ...attemptsDetail,
        },
      },
    }),
    {
      status,
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        'cache-control': 'no-store',
        'x-request-id': requestId,
        ...shouldNotRetryHeaders(status),
        ...corsHeaders(request, env),
      },
    },
  );
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

// Fallback targets skipped by conversion never dispatch, so they leave no failure kind. Only the
// count is reported; the reason can quote client-controlled names and stays in the server log.
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
  // An upstream's route-local 422 can be recorded under the generic client
  // kind even though the Gateway already rotated away from that bad route.
  // Do not let one such failure turn seven transient failures into a terminal
  // non-retryable request. A genuine client error (400, invalid JSON, etc.)
  // must still prevent this classification; pure 422 exhaustion is not transient.
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

// Aggregate by CLIENT-VISIBLE terminal status before selecting the winner.
// Failure kinds that mean the same thing to the client belong to one bucket;
// otherwise rate_limit + rate_limit_global, for example, can lose to one
// unrelated kind merely because they were stored under separate keys.
//
// Tie rule is deliberate and order-independent:
//   504 > 502 > 429
// A timeout tie means the request already spent its waiting window, so do not
// mislabel it as capacity-only 429. A generic upstream failure likewise wins a
// tie over 429 because the request was not purely rate-limited.
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

/**
 * Compact failover evidence safe for default client errors. Only count logical
 * model changes and physical dispatches by tier: never reveal a provider,
 * account, Key ID, raw error, upstream model or configured topology.
 * The newest 64 events bound CPU work and response size in Workers Free.
 */
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
    // A denied admission is not a Provider dispatch, even if it was logged.
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
