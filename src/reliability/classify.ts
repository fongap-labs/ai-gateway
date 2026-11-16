import { clampRetryAfterMs, getLimits, parseRetryAfterMs, QUOTA_RETRY_AFTER_MAX_MS } from '../config/timeouts.ts';
import type { GatewayEnv } from '../types/runtime.ts';
import { UPSTREAM_PROCESSING_ERROR, upstreamProcessingErrorCode } from '../types/upstream-processing.ts';

export const KIND = {
  RATE_LIMIT: 'rate_limit',
  AUTH: 'auth',
  CLIENT: 'client',
  MODEL_MISSING: 'model_missing',
  ENDPOINT_NOT_FOUND: 'endpoint_not_found',
  SERVER: 'server',
  NETWORK: 'network',
  HEADERS_TIMEOUT: 'headers_timeout',
  FIRST_EVENT_TIMEOUT: 'first_event_timeout',
  CLIENT_ABORT: 'client_abort',
  RATE_LIMIT_GLOBAL: 'rate_limit_global',
  INVALID_BASE_URL: 'invalid_base_url',
  STREAM_INTERRUPTED: 'stream_interrupted',
  NON_JSON_BODY: 'upstream_200_non_json_body',
  EMPTY_200: 'upstream_200_no_meaningful_output',
  CANCELLED_AFTER_PEER_COMMIT: 'cancelled_after_peer_commit',
  UNKNOWN: 'unknown',
} as const;

export type FailureKind = (typeof KIND)[keyof typeof KIND];

export type FailureClassification = {
  kind: FailureKind;
  action: 'rotate' | 'stop' | 'neutral';
  cooldownMs: number;
  counted: boolean;
  retryAfterMs?: number;
  modelScoped?: boolean;
  physicalRouteFailure?: boolean;
  uncertain422?: boolean;
  explicitRetryAfter?: boolean;
  requestTooLarge?: boolean;
  forbidden?: boolean;
  rateLimitWindow?: 'window' | 'quota';
};

const CLIENT_STOP_STATUSES = new Set([413, 415, 422]);

const BODY_RETRY_HINT =
  /(?:try again|retry|resets?|available again)\s*(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])\s*)+)/i;
const BODY_RETRY_UNIT = /(\d+(?:\.\d+)?)\s*(ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
const BODY_RESET_AT =
  /(?:resets?|available|try again|retry)\s*(?:at|on|after|until)\s*:?\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i;

export function retryHintFromBody(body: unknown, now: number = Date.now(), maxMs?: number): number {
  const text = String(body || '');
  const clamp = (ms: number) => (maxMs === undefined ? clampRetryAfterMs(ms) : Math.min(Math.max(Math.round(ms), 1_000), maxMs));
  const match = BODY_RETRY_HINT.exec(text);
  if (match?.[1]) {
    let total = 0;
    for (const part of match[1].matchAll(BODY_RETRY_UNIT)) {
      const value = Number(part[1]);
      const unit = String(part[2]).toLowerCase();
      if (!Number.isFinite(value)) return 0;
      if (unit === 'ms') total += value;
      else if (unit.startsWith('h')) total += value * 3_600_000;
      else if (unit.startsWith('m')) total += value * 60_000;
      else total += value * 1_000;
    }
    return total > 0 ? clamp(total) : 0;
  }
  const absolute = BODY_RESET_AT.exec(text);
  if (absolute?.[1]) {
    const at = Date.parse(absolute[1].replace(' ', 'T'));
    if (Number.isFinite(at) && at > now) return clamp(at - now);
  }
  return 0;
}

const HORIZON_WORDING =
  /\b(?:daily|per[ _-]?day|per[ _-]?hour|hourly|per[ _-]?week|weekly|per[ _-]?month|monthly|credits?|balance|usage limit|plan limit|usage cap|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty[ -]?four)[ -]?(?:hours?|hrs?|h))\b|PerDay|PerHour|PerWeek|PerMonth|\u6bcf\u65e5|\u6bcf\u5929|\u6bcf\u5468|\u6bcf\u6708|\u672c\u6708|\u5c0f\u65f6|\u4f7f\u7528\u4e0a\u9650|\u7528\u91cf|\u4f59\u989d|\u6b20\u8d39|\u79ef\u5206|\u5957\u9910/i;
const MINUTE_WORDING = /per[ _-]?minute|per[ _-]?second|\b(?:rpm|tpm|itpm|otpm)\b|\u6bcf\u5206\u949f|\u6bcf\u79d2/i;
const GENERIC_QUOTA_WORDING = /\b(?:quota|billing)\b|\u989d\u5ea6|\u914d\u989d|\u9650\u989d/i;
const GENERIC_WINDOW_WORDING =
  /\b(?:too many requests|concurren\w*|rate[ -]limit(?:s|ed|ing)?)\b|\u901f\u7387\u9650\u5236|\u8bf7\u6c42\u9891\u7387|\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41|\u5e76\u53d1|\u8bbf\u95ee\u91cf\u8fc7\u5927/i;
const WEAK_QUOTA_WORDING = /\bexhausted\b|\u7528\u5b8c|\u7528\u5c3d|\u8017\u5c3d/i;

const WINDOW_HINT_CEILING_MS = 90_000;
const QUOTA_HINT_FLOOR_MS = 600_000;

export function rateLimitWindowOf(body: unknown, hintMs: number = 0): 'window' | 'quota' | undefined {
  const text = String(body || '');
  if (!text) return undefined;
  const isShortHint = hintMs > 0 && hintMs <= WINDOW_HINT_CEILING_MS;
  const hasHorizon = HORIZON_WORDING.test(text);
  const hasMinute = MINUTE_WORDING.test(text);
  if (hasHorizon && !hasMinute) return 'quota';
  if (hasMinute && !hasHorizon) return 'window';
  if (hasHorizon && hasMinute) return hintMs > WINDOW_HINT_CEILING_MS ? 'quota' : 'window';
  if (GENERIC_WINDOW_WORDING.test(text)) return 'window';
  if (GENERIC_QUOTA_WORDING.test(text)) return isShortHint ? 'window' : 'quota';
  if (WEAK_QUOTA_WORDING.test(text)) return 'quota';
  return undefined;
}

function rateLimitClassification(headers: Headers, env: GatewayEnv, now: number, body: unknown = ''): FailureClassification {
  const limits = getLimits(env);
  const longHintMs = parseRetryAfterMs(headers, now, QUOTA_RETRY_AFTER_MAX_MS) || retryHintFromBody(body, now, QUOTA_RETRY_AFTER_MAX_MS);
  let rateLimitWindow = rateLimitWindowOf(body, longHintMs);
  if (!rateLimitWindow && longHintMs > 0) {
    if (longHintMs <= WINDOW_HINT_CEILING_MS) rateLimitWindow = 'window';
    else if (longHintMs >= QUOTA_HINT_FLOOR_MS) rateLimitWindow = 'quota';
  }
  const retryAfterMs = longHintMs <= 0 ? 0 : rateLimitWindow === 'quota' ? longHintMs : clampRetryAfterMs(longHintMs);
  return {
    kind: KIND.RATE_LIMIT,
    action: 'rotate',
    cooldownMs: retryAfterMs || limits.rateLimitCooldownMs,
    retryAfterMs,
    counted: false,
    explicitRetryAfter: retryAfterMs > 0,
    ...(rateLimitWindow ? { rateLimitWindow } : {}),
  };
}

function looksLikeTokenCeiling(body: unknown): boolean {
  const text = String(body || '').toLowerCase();
  if (!text) return false;
  if (/\b(?:itpm|tpm|rpm)\b/.test(text)) return true;
  if (/\b(?:input\s+)?tokens?\s+per\s+minute\b/.test(text)) return true;
  if (/\brequests?\s+per\s+minute\b/.test(text)) return true;
  if (/\brate[ _-]?limit(?:ed|ing)?\b/.test(text)) return true;
  return false;
}

export function classifyUpstreamStatus(
  status: number,
  headers: Headers,
  env: GatewayEnv,
  now: number = Date.now(),
  body: unknown = '',
): FailureClassification {
  const limits = getLimits(env);
  if (status === 429) return rateLimitClassification(headers, env, now, body);
  if (status === 413 && looksLikeTokenCeiling(body)) {
    if (parseRetryAfterMs(headers, now) > 0) return rateLimitClassification(headers, env, now, body);
    return { kind: KIND.CLIENT, action: 'rotate', cooldownMs: 0, counted: false, requestTooLarge: true };
  }
  if (status === 401) {
    return { kind: KIND.AUTH, action: 'rotate', cooldownMs: limits.authFailCooldownMs, counted: false };
  }
  if (status === 403) {
    return { kind: KIND.AUTH, action: 'rotate', cooldownMs: limits.authFailCooldownMs, counted: false, forbidden: true };
  }
  if (status === 400) {
    return { kind: KIND.CLIENT, action: looksLikeInvalidRequestPayload(body) ? 'stop' : 'rotate', cooldownMs: 0, counted: false };
  }
  if (status === 422) {
    if (looksLikeInvalidRequestPayload(body) || hasNonOptionalValidationErrors(body)) {
      return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
    }
    const error = structuredUpstreamError(body);
    if (error && CLIENT_REQUEST_ERROR_CODES.has(error.code)) {
      return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
    }
    if (error && MODEL_ROUTE_ERROR_CODES.has(error.code)) {
      return { kind: KIND.MODEL_MISSING, action: 'rotate', cooldownMs: 5_000, counted: false, modelScoped: true };
    }
    if (error && ENDPOINT_ROUTE_ERROR_CODES.has(error.code)) {
      return { kind: KIND.ENDPOINT_NOT_FOUND, action: 'rotate', cooldownMs: 5_000, counted: false, physicalRouteFailure: true };
    }
    if (error && UNSUPPORTED_ROUTE_ERROR_CODES.has(error.code)) {
      return { kind: KIND.CLIENT, action: 'rotate', cooldownMs: 0, counted: false, physicalRouteFailure: true };
    }
    if (looksLikeUnsupportedRequestFeature(body) || looksLikeSchemaRejectedOptionalFields(body)) {
      return { kind: KIND.CLIENT, action: 'rotate', cooldownMs: 0, counted: false, physicalRouteFailure: true };
    }
    if (looksLikeModelMissing(body)) {
      return { kind: KIND.MODEL_MISSING, action: 'rotate', cooldownMs: 5_000, counted: false, modelScoped: true };
    }
    if (/\bendpoint[_ -]?not[_ -]?found\b/i.test(String(body || ''))) {
      return { kind: KIND.ENDPOINT_NOT_FOUND, action: 'rotate', cooldownMs: 5_000, counted: false, physicalRouteFailure: true };
    }
    return { kind: KIND.CLIENT, action: 'rotate', cooldownMs: 0, counted: false, physicalRouteFailure: true, uncertain422: true };
  }
  if (CLIENT_STOP_STATUSES.has(status)) {
    return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
  }
  if (status === 404) {
    const error = structuredUpstreamError(body);
    if (
      (error && (MODEL_ROUTE_ERROR_CODES.has(error.code) || MODEL_ACCESS_ERROR_CODES.has(error.code))) ||
      looksLikeModelAccessDenied(body) ||
      looksLikeModelMissing(body)
    ) {
      return { kind: KIND.MODEL_MISSING, action: 'rotate', cooldownMs: 5_000, counted: false, modelScoped: true };
    }
    return { kind: KIND.ENDPOINT_NOT_FOUND, action: 'rotate', cooldownMs: 5_000, counted: false };
  }
  if (status === 408 || status === 425) {
    return { kind: KIND.SERVER, action: 'rotate', cooldownMs: 0, counted: true };
  }
  if (status === 409) {
    return { kind: KIND.SERVER, action: 'stop', cooldownMs: 0, counted: false };
  }
  if (status >= 500) {
    return { kind: KIND.SERVER, action: 'rotate', cooldownMs: 0, counted: true };
  }
  return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
}

const MODEL_ROUTE_ERROR_CODES = new Set([
  'model_not_found',
  'model_unavailable',
  'model_unsupported',
  'model_not_supported',
  'invalid_model',
  'no_such_model',
  'deployment_not_found',
  'no_available_providers',
]);
const MODEL_ACCESS_ERROR_CODES = new Set([
  'model_access_denied',
  'model_forbidden',
  'model_permission_denied',
  'model_not_authorized',
  'model_not_enabled',
]);
const CLIENT_REQUEST_ERROR_CODES = new Set([
  'invalid_request_error',
  'invalid_json',
  'context_length_exceeded',
  'invalid_request',
  'malformed_request',
]);
const ENDPOINT_ROUTE_ERROR_CODES = new Set(['endpoint_not_found', 'route_not_found', 'unsupported_endpoint', 'endpoint_unsupported']);
const UNSUPPORTED_ROUTE_ERROR_CODES = new Set([
  'unsupported_parameter',
  'unsupported_value',
  'unsupported_feature',
  'unsupported_tool',
  'unsupported_tool_type',
  'unknown_parameter',
  'unrecognized_parameter',
  'unknown_field',
  'unrecognized_field',
]);

function structuredUpstreamError(body: unknown): { code: string } | null {
  if (typeof body !== 'string' || body.length > 4096) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    const source = root.error && typeof root.error === 'object' && !Array.isArray(root.error) ? (root.error as Record<string, unknown>) : root;
    const code = typeof source.code === 'string' ? source.code.trim().toLowerCase() : '';
    return code ? { code } : null;
  } catch {
    return null;
  }
}

const OPTIONAL_UPSTREAM_FIELDS = new Set([
  'reasoning',
  'reasoning_effort',
  'thinking',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'stream_options',
  'response_format',
  'max_output_tokens',
  'max_completion_tokens',
  'include',
  'store',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'seed',
  'logprobs',
  'top_logprobs',
]);

function looksLikeSchemaRejectedOptionalFields(body: unknown): boolean {
  if (typeof body !== 'string' || body.length > 4096) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const detail = (parsed as Record<string, unknown>).detail;
    if (!Array.isArray(detail) || detail.length === 0 || detail.length > 16) return false;
    return detail.every((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const issue = item as Record<string, unknown>;
      const loc = issue.loc;
      return (
        issue.type === 'extra_forbidden' &&
        Array.isArray(loc) &&
        loc.length === 2 &&
        loc[0] === 'body' &&
        typeof loc[1] === 'string' &&
        OPTIONAL_UPSTREAM_FIELDS.has(loc[1])
      );
    });
  } catch {
    return false;
  }
}

function hasNonOptionalValidationErrors(body: unknown): boolean {
  if (typeof body !== 'string' || body.length > 4096) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const detail = (parsed as Record<string, unknown>).detail;
    return Array.isArray(detail) && detail.length > 0 && !looksLikeSchemaRejectedOptionalFields(body);
  } catch {
    return false;
  }
}

function looksLikeInvalidRequestPayload(body: unknown): boolean {
  const text = String(body || '');
  return /\b(?:invalid|malformed)\s+json\b|\bjson\s+parse\s+error\b|\binvalid\s+request\s+body\b|\b(?:missing|required)\s+(?:a\s+)?required\s+(?:field|parameter)\b|\brequired\s+field\s+missing\b|\bmessages\s+must\s+be\s+an?\s+(?:array|list)\b/i.test(
    text,
  );
}

function looksLikeUnsupportedRequestFeature(body: unknown): boolean {
  const text = String(body || '');
  return (
    /\b(?:unsupported|unknown|unrecognized|not supported|does not support)\s+(?:request\s+)?(?:parameter|field|option|feature|argument|tool(?:s| calling)?|image(?: input)?|reasoning|thinking|streaming)\b/i.test(
      text,
    ) ||
    /\b(?:parameter|field|option|feature|argument|tool(?:s| calling)?|image(?: input)?|reasoning|thinking|streaming)\b.{0,90}\b(?:unsupported|not supported|does not support|not available for this model)\b/i.test(
      text,
    )
  );
}

function looksLikeModelAccessDenied(body: unknown): boolean {
  const text = String(body || '');
  return (
    /\b(?:model|deployment)\b.{0,100}\b(?:access denied|permission denied|not authorized|not permitted|not enabled|not entitled|not allowed|not available to (?:your|this) (?:account|organization|key))\b/i.test(
      text,
    ) ||
    /\b(?:access denied|permission denied|not authorized|not permitted|not enabled|not entitled|not allowed)\b.{0,100}\b(?:model|deployment)\b/i.test(
      text,
    )
  );
}

function looksLikeModelMissing(body: unknown): boolean {
  const text = String(body || '').toLowerCase();
  if (/\bno endpoints? found\b/.test(text)) return true;
  if (/\bno available providers?\b/.test(text)) return true;
  if (!text.includes('model')) return false;
  return /(not found|does not exist|unknown|no such|not supported|invalid model|not available|unavailable)/.test(text);
}

export function classifyNetworkError(isHeadersTimeout: boolean): FailureClassification {
  return isHeadersTimeout
    ? { kind: KIND.HEADERS_TIMEOUT, action: 'rotate', cooldownMs: 0, counted: true }
    : { kind: KIND.NETWORK, action: 'rotate', cooldownMs: 0, counted: true };
}

export function classifyFirstEventFailure(): FailureClassification {
  return { kind: KIND.FIRST_EVENT_TIMEOUT, action: 'rotate', cooldownMs: 0, counted: true };
}

export function classifyPostHeadersFailure(error: unknown): FailureClassification {
  const code = upstreamProcessingErrorCode(error);
  if (code === UPSTREAM_PROCESSING_ERROR.DEADLINE) return classifyFirstEventFailure();
  if (code === UPSTREAM_PROCESSING_ERROR.MALFORMED || code === UPSTREAM_PROCESSING_ERROR.TOO_LARGE) return classifyNonJsonBody();
  if (code === UPSTREAM_PROCESSING_ERROR.TRUNCATED) return classifyStreamInterrupted();
  if (code === UPSTREAM_PROCESSING_ERROR.EMPTY) return classifyEmptyResponse();
  if (code === UPSTREAM_PROCESSING_ERROR.TERMINAL) {
    return { kind: KIND.SERVER, action: 'rotate', cooldownMs: 0, counted: true };
  }
  if (error instanceof SyntaxError) return classifyNonJsonBody();
  return classifyFirstEventFailure();
}

export function classifyOversizedReply(): FailureClassification {
  return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
}

export function classifyConversionBudget(): FailureClassification {
  return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
}

export function classifyClientAbort(): FailureClassification {
  return { kind: KIND.CLIENT_ABORT, action: 'neutral', cooldownMs: 0, counted: false };
}

export function classifyPreDispatchInvalidBaseUrl(): FailureClassification {
  return { kind: KIND.INVALID_BASE_URL, action: 'rotate', cooldownMs: 0, counted: false };
}

export function classifyNonJsonBody(): FailureClassification {
  return { kind: KIND.NON_JSON_BODY, action: 'rotate', cooldownMs: 5_000, counted: true };
}

export function classifyEmptyResponse(): FailureClassification {
  return { kind: KIND.EMPTY_200, action: 'rotate', cooldownMs: 5_000, counted: true };
}

export function classifyStreamInterrupted(): FailureClassification {
  return { kind: KIND.STREAM_INTERRUPTED, action: 'rotate', cooldownMs: 60_000, counted: true };
}

export function classifyHedgeRaceLoss(): FailureClassification {
  return { kind: KIND.CANCELLED_AFTER_PEER_COMMIT, action: 'neutral', cooldownMs: 0, counted: false };
}

export function classifyHedgeUnknown(): FailureClassification {
  return { kind: KIND.UNKNOWN, action: 'rotate', cooldownMs: 0, counted: false };
}
