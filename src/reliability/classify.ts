// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Upstream error classification. One function decides, per failed attempt,
// whether the request should rotate to another node in the same tier, stop
// entirely, or end neutrally — and which node-local cooldown applies.
//
// Rules of scope: every failure here is NODE-local. Never punish a provider,
// tier, or the whole gateway for one node's 429/401.

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
  explicitRetryAfter?: boolean;
  /** The upstream said this request is larger than the model accepts (413). */
  requestTooLarge?: boolean;
  /**
   * What kind of allowance a 429 ran into, judged from the response wording and,
   * when the wording says nothing, from the magnitude of an explicit wait hint:
   * 'window' = a short per-minute style limit, 'quota' = a long-lived allowance
   * (daily, hourly plan, credits). Absent when neither signal says.
   */
  rateLimitWindow?: 'window' | 'quota';
};

const CLIENT_STOP_STATUSES = new Set([413, 415, 422]);

// "Please try again in 7.66s", "try again in 12m3.5s", "resets in 2 hours": many
// providers state the wait in the error text when they send no Retry-After header.
const BODY_RETRY_HINT =
  /(?:try again|retry|resets?|available again)\s*(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])\s*)+)/i;
const BODY_RETRY_UNIT = /(\d+(?:\.\d+)?)\s*(ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
// "resets at 2026-10-20T15:00:00Z": an absolute reset instant. Only a timestamp that
// carries its own zone is read; a bare local time has no safe interpretation.
const BODY_RESET_AT =
  /(?:resets?|available|try again|retry)\s*(?:at|on|after|until)\s*:?\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i;

/**
 * Wait the response text asks for, in ms. A 429 that names a long-lived allowance
 * may state hours ("resets in 4 hours"), so the ceiling is the caller's: it keeps
 * the 10-minute Retry-After window by default and widens it once the 429 is known
 * to be a long-lived allowance.
 */
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

// Long-lived allowances (daily / hourly / plan window / credits) versus short
// per-minute limits, from wording alone. Deliberately conservative: text that says
// neither stays unclassified and keeps the default ladder. Chinese wording is
// matched by code point escapes so the source stays English-only.
//
// Three tiers of evidence, strongest first:
//   * a stated horizon ("per day", "5-hour", "credits", "plan limit") names how long
//     the limit lasts;
//   * a stated minute unit ("per minute", "rpm", "tpm") names a short window;
//   * generic words ("quota", "rate limit", "too many requests") only say a limit
//     was hit. Gemini-style "You exceeded your current quota ... PerMinute ... retry
//     in 28s" is a per-minute limit that merely uses the word quota, so a generic
//     quota word must not outweigh an explicit minute unit or a short wait hint.
// Horizon words that also appear in plan/billing boilerplate ("check your plan and
// billing details") are deliberately NOT horizon evidence.
const HORIZON_WORDING =
  /\b(?:daily|per[ _-]?day|per[ _-]?hour|hourly|per[ _-]?week|weekly|per[ _-]?month|monthly|credits?|balance|usage limit|plan limit|usage cap|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty[ -]?four)[ -]?(?:hours?|hrs?|h))\b|PerDay|PerHour|PerWeek|PerMonth|\u6bcf\u65e5|\u6bcf\u5929|\u6bcf\u5468|\u6bcf\u6708|\u672c\u6708|\u5c0f\u65f6|\u4f7f\u7528\u4e0a\u9650|\u7528\u91cf|\u4f59\u989d|\u6b20\u8d39|\u79ef\u5206|\u5957\u9910/i;
const MINUTE_WORDING = /per[ _-]?minute|per[ _-]?second|\b(?:rpm|tpm|itpm|otpm)\b|\u6bcf\u5206\u949f|\u6bcf\u79d2/i;
const GENERIC_QUOTA_WORDING = /\b(?:quota|billing)\b|\u989d\u5ea6|\u914d\u989d|\u9650\u989d/i;
const GENERIC_WINDOW_WORDING =
  /\b(?:too many requests|concurren\w*|rate[ -]limit(?:s|ed|ing)?)\b|\u901f\u7387\u9650\u5236|\u8bf7\u6c42\u9891\u7387|\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41|\u5e76\u53d1|\u8bbf\u95ee\u91cf\u8fc7\u5927/i;
// "exhausted" proves a limit ran out but not its horizon: only a WEAK long-lived
// hint after minute-window wording has been ruled out. "inference tpm exhausted"
// stays a window, while "plan limit exhausted" (caught above) and a bare
// "exhausted" read as a long-lived allowance.
const WEAK_QUOTA_WORDING = /\bexhausted\b|\u7528\u5b8c|\u7528\u5c3d|\u8017\u5c3d/i;

// An explicit provider-stated wait is itself a classification signal when the
// wording says nothing: a minute-and-a-half or less can only be a short window,
// while ten minutes or more can only be a long-lived allowance. Only an EXPLICIT
// hint counts — the default cooldown never guesses a class.
const WINDOW_HINT_CEILING_MS = 90_000;
const QUOTA_HINT_FLOOR_MS = 600_000;

/**
 * Short window versus long-lived allowance, from the response wording. `hintMs` is
 * the provider's own explicit wait (0 when it gave none); it only arbitrates
 * ambiguous wording, never overrides a stated minute unit or horizon on its own.
 */
export function rateLimitWindowOf(body: unknown, hintMs: number = 0): 'window' | 'quota' | undefined {
  const text = String(body || '');
  if (!text) return undefined;
  const isShortHint = hintMs > 0 && hintMs <= WINDOW_HINT_CEILING_MS;
  const hasHorizon = HORIZON_WORDING.test(text);
  const hasMinute = MINUTE_WORDING.test(text);
  if (hasHorizon && !hasMinute) return 'quota';
  if (hasMinute && !hasHorizon) return 'window';
  // Both a horizon and a minute unit are named (a response listing every limit of
  // the plan): a wait beyond the minute window proves the long one, otherwise lean
  // to the window. The lean is the self-correcting side: a daily limit mistaken for
  // a window is promoted to the long-allowance ladder after a few short probes,
  // while a minute limit mistaken for a long allowance would idle the key for
  // minutes on every incident.
  if (hasHorizon && hasMinute) return hintMs > WINDOW_HINT_CEILING_MS ? 'quota' : 'window';
  if (GENERIC_QUOTA_WORDING.test(text)) return isShortHint ? 'window' : 'quota';
  if (GENERIC_WINDOW_WORDING.test(text)) return 'window';
  if (WEAK_QUOTA_WORDING.test(text)) return 'quota';
  return undefined;
}

function rateLimitClassification(headers: Headers, env: GatewayEnv, now: number, body: unknown = ''): FailureClassification {
  const limits = getLimits(env);
  // Read the provider's wait with the long-allowance ceiling first: classification
  // needs its real magnitude, and only a long-lived allowance keeps more than the
  // ordinary 10-minute window of it.
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

// A 413 that quotes a token-per-minute ceiling is about THIS request being larger
// than the model accepts (Groq: "Request too large ... tokens per minute (TPM)"),
// not about the key being throttled: smaller requests to the same key still work.
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
  // Request-local, like a 400: this node cannot take this request, so routing
  // continues elsewhere, but the key is not put on a cooldown ladder and stays
  // available for requests that fit. A Retry-After header says the refusal is
  // time based (a real throttle), so that case stays a rate limit.
  if (status === 413 && looksLikeTokenCeiling(body)) {
    if (parseRetryAfterMs(headers, now) > 0) return rateLimitClassification(headers, env, now, body);
    return { kind: KIND.CLIENT, action: 'rotate', cooldownMs: 0, counted: false, requestTooLarge: true };
  }
  if (status === 401 || status === 403) {
    return { kind: KIND.AUTH, action: 'rotate', cooldownMs: limits.authFailCooldownMs, counted: false };
  }
  // A 400 from one OpenAI-compatible upstream is not proof that the client
  // request is invalid everywhere. Treat it as request-local incompatibility:
  // the current node/account is excluded by recordOutcome(), then routing may
  // continue through another provider/key without applying shared cooldown.
  if (status === 400) {
    return { kind: KIND.CLIENT, action: 'rotate', cooldownMs: 0, counted: false };
  }
  if (CLIENT_STOP_STATUSES.has(status)) {
    return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
  }
  if (status === 404) {
    if (looksLikeModelMissing(body)) {
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

function looksLikeModelMissing(body: unknown): boolean {
  const text = String(body || '').toLowerCase();
  // "No endpoints found for <model>" (a router with no provider for that model).
  if (/\bno endpoints? found\b/.test(text)) return true;
  if (!text.includes('model')) return false;
  return /(not found|does not exist|unknown|no such|not supported|invalid model)/.test(text);
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
