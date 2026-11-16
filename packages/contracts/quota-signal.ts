import type { Protocol } from './protocol.ts';

export type QuotaSignal = {
  remainingRequests?: number;
  remainingTokens?: number;
  limitRequests?: number;
  limitTokens?: number;
  resetAtMs?: number;
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

function parseResetToMs(raw: string | null, now: number): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const compoundMs = parseCompoundDurationMs(trimmed);
  if (compoundMs !== undefined) return now + compoundMs;
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
