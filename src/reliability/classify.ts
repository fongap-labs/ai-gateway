// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Upstream error classification. One function decides, per failed attempt,
// whether the request should rotate to another node in the same tier, stop
// entirely, or end neutrally — and which node-local cooldown applies.
//
// Rules of scope: every failure here is NODE-local. Never punish a provider,
// tier, or the whole gateway for one node's 429/401.

import { clampRetryAfterMs, getLimits, parseRetryAfterMs } from '../config/timeouts.ts';
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
   * What kind of allowance a 429 ran into, judged from the response text alone:
   * 'window' = a short per-minute style limit, 'quota' = a long-lived allowance
   * (daily, hourly plan, credits). Absent when the text does not say.
   */
  rateLimitWindow?: 'window' | 'quota';
};

const CLIENT_STOP_STATUSES = new Set([413, 415, 422]);

// "Please try again in 7.66s", "try again in 12m3.5s", "resets in 2 hours": many
// providers state the wait in the error text when they send no Retry-After header.
const BODY_RETRY_HINT =
  /(?:try again|retry|resets?|available again)\s*(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])\s*)+)/i;
const BODY_RETRY_UNIT = /(\d+(?:\.\d+)?)\s*(ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;

export function retryHintFromBody(body: unknown): number {
  const match = BODY_RETRY_HINT.exec(String(body || ''));
  if (!match?.[1]) return 0;
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
  return total > 0 ? clampRetryAfterMs(total) : 0;
}

// Long-lived allowances (daily / plan window / credits) versus short per-minute
// limits, from wording alone. Deliberately conservative: text that says neither
// stays unclassified and keeps the default ladder. Chinese wording is matched by
// code point escapes so the source stays English-only.
const QUOTA_WORDING =
  /\b(?:quota|daily|per[ -]day|credits?|balance|billing|usage limit|plan limit|exhausted)\b|\u989d\u5ea6|\u914d\u989d|\u7528\u5b8c|\u7528\u5c3d|\u8017\u5c3d|\u6bcf\u65e5|\u6bcf\u5929|\u6bcf\s*\d+\s*\u5c0f\u65f6|\u4f59\u989d|\u6b20\u8d39/i;
const WINDOW_WORDING = /\b(?:per[ -]minute|per[ -]second|rpm|tpm|itpm|otpm|too many requests|concurren\w*)\b/i;

export function rateLimitWindowOf(body: unknown): 'window' | 'quota' | undefined {
  const text = String(body || '');
  if (!text) return undefined;
  if (QUOTA_WORDING.test(text)) return 'quota';
  if (WINDOW_WORDING.test(text)) return 'window';
  return undefined;
}

function rateLimitClassification(headers: Headers, env: GatewayEnv, now: number, body: unknown = ''): FailureClassification {
  const limits = getLimits(env);
  const retryAfterMs = parseRetryAfterMs(headers, now) || retryHintFromBody(body);
  const rateLimitWindow = rateLimitWindowOf(body);
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
