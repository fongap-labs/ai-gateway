// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Provider-reported quota signal extraction.
//
// Many OpenAI-protocol and Anthropic-protocol upstreams announce their rate
// windows on response headers (remaining requests/tokens, the window limit,
// and a reset marker). This module turns those protocol-convention headers
// into a neutral QuotaSignal the reliability layer can consume. It is
// protocol-keyed (OpenAI / Anthropic wire conventions), never provider-name
// branched; providers that do not report quota simply produce no signal and
// the gateway keeps its reactive adaptive-429 + cooldown behavior untouched.
//
// The signal is a HINT, never truth: callers cap, classify, and still apply
// their own recovery model. Unknown quota is never fabricated into a hard
// limit.

import type { Protocol } from '../types/protocol.ts';

export type QuotaSignal = {
  /** Remaining requests in the current window, if the provider reported one. */
  remainingRequests?: number;
  /** Remaining tokens in the current window, if reported. */
  remainingTokens?: number;
  /** The window ceiling (requests), used to derive a remaining ratio. */
  limitRequests?: number;
  /** The window ceiling (tokens), used to derive a remaining ratio. */
  limitTokens?: number;
  /** Wall-clock instant (epoch ms) at which the window resets, if known. */
  resetAtMs?: number;
  /** Provenance label for diagnostics (e.g. 'openai-headers'). */
  source?: string;
};

const OPENAI_REMAINING_REQUESTS = 'x-ratelimit-remaining-requests';
const OPENAI_REMAINING_TOKENS = 'x-ratelimit-remaining-tokens';
const OPENAI_LIMIT_REQUESTS = 'x-ratelimit-limit-requests';
const OPENAI_LIMIT_TOKENS = 'x-ratelimit-limit-tokens';
const OPENAI_RESET_REQUESTS = 'x-ratelimit-reset-requests';
const OPENAI_RESET_TOKENS = 'x-ratelimit-reset-tokens';

const ANTHROPIC_REMAINING_REQUESTS = 'anthropic-ratelimit-requests-remaining';
const ANTHROPIC_REMAINING_TOKENS = 'anthropic-ratelimit-tokens-remaining';
const ANTHROPIC_LIMIT_REQUESTS = 'anthropic-ratelimit-requests-limit';
const ANTHROPIC_LIMIT_TOKENS = 'anthropic-ratelimit-tokens-limit';
const ANTHROPIC_RESET_REQUESTS = 'anthropic-ratelimit-requests-reset';
const ANTHROPIC_RESET_TOKENS = 'anthropic-ratelimit-tokens-reset';

function parseNonNegativeInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

const DURATION_UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };

// Go-style compound durations ("1h0m0s", "6m30s", "500ms") must be summed;
// treating them as plain seconds yields an absurd float or NaN.
function parseCompoundDurationMs(trimmed: string): number | undefined {
  const tokens = [...trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (!tokens.length || tokens.map((token) => token[0]).join('') !== trimmed) return undefined;
  let total = 0;
  for (const token of tokens) {
    const value = Number(token[1]);
    const unit = DURATION_UNIT_MS[token[2] ?? ''];
    if (!Number.isFinite(value) || unit === undefined) return undefined;
    total += value * unit;
  }
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

// OpenAI reset headers carry a duration ("1s" / "500ms" / "1h0m0s") or plain
// seconds; Anthropic reset headers carry remaining seconds. An absolute epoch
// (10-digit seconds or 13-digit ms) must be recognized BEFORE plain seconds:
// reading "1729400000" as seconds would push the reset ~55 years into the future.
function parseResetToMs(raw: string | null, now: number): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const compoundMs = parseCompoundDurationMs(trimmed);
  if (compoundMs !== undefined) return now + compoundMs;
  // Absolute epoch (seconds or ms).
  if (/^\d{9,16}$/.test(trimmed)) {
    const value = Number(trimmed);
    const epochMs = value > 1e12 ? value : value * 1000;
    return epochMs > now ? epochMs : undefined;
  }
  const secMatch = /^(\d+(?:\.\d+)?)$/.exec(trimmed);
  if (secMatch) {
    const sec = Number(secMatch[1]);
    return Number.isFinite(sec) && sec > 0 ? now + sec * 1000 : undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > now ? parsed : undefined;
}

function pickReset(headers: Headers, names: readonly string[], now: number): number | undefined {
  for (const name of names) {
    const at = parseResetToMs(headers.get(name), now);
    if (at !== undefined) return at;
  }
  return undefined;
}

/** Extract a provider-reported quota signal from response headers, or
 *  `null` when the upstream reports no quota markers (unknown quota). */
export function extractQuotaSignal(protocol: Protocol, headers: Headers, now: number = Date.now()): QuotaSignal | null {
  if (protocol === 'anthropic') {
    const remainingRequests = parseNonNegativeInt(headers.get(ANTHROPIC_REMAINING_REQUESTS));
    const remainingTokens = parseNonNegativeInt(headers.get(ANTHROPIC_REMAINING_TOKENS));
    if (remainingRequests === undefined && remainingTokens === undefined) return null;
    return {
      ...(remainingRequests !== undefined ? { remainingRequests } : {}),
      ...(remainingTokens !== undefined ? { remainingTokens } : {}),
      limitRequests: parseNonNegativeInt(headers.get(ANTHROPIC_LIMIT_REQUESTS)),
      limitTokens: parseNonNegativeInt(headers.get(ANTHROPIC_LIMIT_TOKENS)),
      resetAtMs: pickReset(headers, [ANTHROPIC_RESET_REQUESTS, ANTHROPIC_RESET_TOKENS], now),
      source: 'anthropic-headers',
    };
  }
  if (protocol === 'openai') {
    const remainingRequests = parseNonNegativeInt(headers.get(OPENAI_REMAINING_REQUESTS));
    const remainingTokens = parseNonNegativeInt(headers.get(OPENAI_REMAINING_TOKENS));
    if (remainingRequests === undefined && remainingTokens === undefined) return null;
    return {
      ...(remainingRequests !== undefined ? { remainingRequests } : {}),
      ...(remainingTokens !== undefined ? { remainingTokens } : {}),
      limitRequests: parseNonNegativeInt(headers.get(OPENAI_LIMIT_REQUESTS)),
      limitTokens: parseNonNegativeInt(headers.get(OPENAI_LIMIT_TOKENS)),
      resetAtMs: pickReset(headers, [OPENAI_RESET_REQUESTS, OPENAI_RESET_TOKENS], now),
      source: 'openai-headers',
    };
  }
  return null;
}
