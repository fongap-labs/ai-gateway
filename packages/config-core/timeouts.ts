// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { clampInt, getBool, readEnv } from './env.ts';
import type { RuntimeTunableName } from './runtime-vars.ts';
import { RUNTIME_TUNABLES } from './runtime-vars.ts';

const LIMITS = Object.fromEntries(RUNTIME_TUNABLES.map((v) => [v.name, { min: v.min, max: v.max, def: v.def }])) as Record<
  RuntimeTunableName,
  { min: number; max: number; def: number }
>;

const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 600_000;
export const QUOTA_RETRY_AFTER_MAX_MS = 6 * 3_600_000;

export const MIN_ATTEMPT_HEADERS_MS = 20_000;
export const MIN_ATTEMPT_FIRST_EVENT_MS = 5_000;

export const PRIVATE_CENTER_RESPONSE_RESERVE_MS = 1_500;

export function centerResponseDeadlineMs(deadlineMs: number, nowMs: number = Date.now()): number {
  const now = Math.floor(nowMs);
  const deadline = Number.isFinite(deadlineMs) ? Math.floor(deadlineMs) : now + 1;
  const remaining = Math.max(1, deadline - now);
  const reserve = Math.min(PRIVATE_CENTER_RESPONSE_RESERVE_MS, Math.max(1, Math.floor(remaining / 20)));
  return Math.max(now + 1, deadline - reserve);
}

export const MIN_FAILOVER_RESERVE_MS = 5_000;

export const SIZE_ALLOWANCE_FREE_CHARS = 50_000;
export const SIZE_ALLOWANCE_CHARS_PER_SEC = 25_000;
export const SIZE_ALLOWANCE_MAX_MS = 45_000;

export function requestSizeAllowanceMs(bodyChars: number | undefined | null): number {
  if (typeof bodyChars !== 'number' || !Number.isFinite(bodyChars) || bodyChars <= SIZE_ALLOWANCE_FREE_CHARS) return 0;
  const allowance = Math.floor(((bodyChars - SIZE_ALLOWANCE_FREE_CHARS) / SIZE_ALLOWANCE_CHARS_PER_SEC) * 1_000);
  return Math.min(SIZE_ALLOWANCE_MAX_MS, allowance);
}

export const HEDGE_ADAPTIVE_MAX_MS = 20_000;
export const HEDGE_BUFFERED_MIN_MS = 10_000;

export function adaptiveHedgeDelayMs(
  configuredMs: number,
  { bodyChars, ttftEwmaMs, isBuffered }: { bodyChars?: number | null; ttftEwmaMs?: number | null; isBuffered?: boolean },
): number {
  let delay = configuredMs;
  const expectedTtft = typeof ttftEwmaMs === 'number' && Number.isFinite(ttftEwmaMs) && ttftEwmaMs > 0 ? 2 * ttftEwmaMs : 0;
  delay = Math.max(delay, Math.min(HEDGE_ADAPTIVE_MAX_MS, expectedTtft), Math.min(HEDGE_ADAPTIVE_MAX_MS, requestSizeAllowanceMs(bodyChars)));
  if (isBuffered) delay = Math.max(delay, HEDGE_BUFFERED_MIN_MS);
  return Math.round(delay);
}

export type Limits = {
  headersTimeoutMs: number;
  firstEventTimeoutMs: number;
  streamIdleTimeoutMs: number;
  rateLimitCooldownMs: number;
  authFailCooldownMs: number;
  maxBodyBytes: number;
  failoverBudgetMs: number;
  hedgeDelayMs: number;
  isHedgeDelayExplicit: boolean;
  maxHedgesPerRequest: number;
  gatewayKeyRpm: number;
  authAttemptRpm: number;
  edgeCacheTtlSec: number;
  tier1ProbeV2: boolean;
  tier1ProbeTimeoutMs: number;
  streamPassthrough: boolean;
  streamGuardPrefixBytes: number;
  conversionBudget: boolean;
  conversionBudgetMode: 'error' | 'truncate';
  conversionBudgetCfg: {
    maxEvents: number;
    maxOutputUnits: number;
    maxToolEvents: number;
    maxToolArgUnits: number;
  };
  conversionNonstreamMaxUnits: number;
  conversionBudgetMaxTokens: number;
  conversionPreferNonstream: boolean;
  requestAdmission: boolean;
  isolateMaxInFlight: number;
  chunkedBodyMaxBytes: number;
  streamMaxAttempts: number;
  nonStreamMaxAttempts: number;
  tier1AffinityWrite: boolean;
  tokenD1SamplePct: number;
  logLevelDefault: string;
  hotPathGuards: boolean;
  affinityReadTimeoutMs: number;
};

export function attemptBudgetSliceMs(remainingBudgetMs: number, remainingAttempts: number): number {
  const attempts = Math.max(1, Math.trunc(remainingAttempts) || 1);
  return Math.max(1, Math.floor(Math.max(0, remainingBudgetMs) / attempts));
}

export function attemptBudgetWindowMs(remainingBudgetMs: number, remainingAttempts: number): number {
  const attempts = Math.max(1, Math.trunc(remainingAttempts) || 1);
  const budget = Math.max(0, Math.floor(remainingBudgetMs));
  if (budget <= 0) return 1;
  if (attempts === 1) return Math.max(1, budget);

  const equalShare = Math.max(1, Math.floor(budget / attempts));
  const reservePerLater = Math.min(MIN_FAILOVER_RESERVE_MS, equalShare);
  const reservedForLater = reservePerLater * (attempts - 1);
  return Math.max(1, budget - reservedForLater);
}

function fairShareTimeoutMs(configuredTimeoutMs: number, remainingBudgetMs: number, remainingAttempts: number, floorMs: number): number {
  const attempts = Math.max(1, Math.trunc(remainingAttempts) || 1);
  const budget = Math.max(0, remainingBudgetMs);
  const share = Math.floor(budget / attempts);
  const wait = Math.min(configuredTimeoutMs, budget, Math.max(floorMs, share));
  return Math.max(1, wait);
}

export function attemptHeadersTimeoutMs(headersTimeoutMs: number, remainingBudgetMs: number, remainingAttempts: number): number {
  return fairShareTimeoutMs(headersTimeoutMs, remainingBudgetMs, remainingAttempts, MIN_ATTEMPT_HEADERS_MS);
}

export function attemptFirstEventTimeoutMs(firstEventTimeoutMs: number, remainingBudgetMs: number, remainingAttempts: number): number {
  return fairShareTimeoutMs(firstEventTimeoutMs, remainingBudgetMs, remainingAttempts, MIN_ATTEMPT_FIRST_EVENT_MS);
}

const cache = new WeakMap<object, Limits>();
const EMPTY_ENV: Record<string, unknown> = {};

function conversionBudgetModeOf(env: Record<string, unknown>): 'error' | 'truncate' {
  return readEnv(env, 'AIG_CONVERSION_BUDGET_MODE')?.toLowerCase() === 'truncate' ? 'truncate' : 'error';
}

function maxHedgesFor(env: Record<string, unknown>): number {
  const raw = readEnv(env, 'AIG_REQUEST_HEDGE_MAX');
  if (raw !== undefined) {
    return clampInt(raw, LIMITS.AIG_REQUEST_HEDGE_MAX.min, LIMITS.AIG_REQUEST_HEDGE_MAX.max, LIMITS.AIG_REQUEST_HEDGE_MAX.def);
  }
  return getBool(env, 'AIG_REQUEST_ADMISSION', false) ? 0 : LIMITS.AIG_REQUEST_HEDGE_MAX.def;
}

export function getLimits(env: Record<string, unknown>): Limits {
  const cacheKey = typeof env === 'object' && env !== null ? env : EMPTY_ENV;
  let cached = cache.get(cacheKey);
  if (cached) return cached;
  const costGuards = getBool(env, 'AIG_COST_GUARDS', false);
  const hotPathGuards = getBool(env, 'AIG_HOT_PATH_GUARDS', false);
  cached = {
    headersTimeoutMs: clampInt(
      readEnv(env, 'AIG_UPSTREAM_HEADER_TIMEOUT_MS'),
      LIMITS.AIG_UPSTREAM_HEADER_TIMEOUT_MS.min,
      LIMITS.AIG_UPSTREAM_HEADER_TIMEOUT_MS.max,
      LIMITS.AIG_UPSTREAM_HEADER_TIMEOUT_MS.def,
    ),
    firstEventTimeoutMs: clampInt(
      readEnv(env, 'AIG_FIRST_EVENT_TIMEOUT_MS'),
      LIMITS.AIG_FIRST_EVENT_TIMEOUT_MS.min,
      LIMITS.AIG_FIRST_EVENT_TIMEOUT_MS.max,
      LIMITS.AIG_FIRST_EVENT_TIMEOUT_MS.def,
    ),
    streamIdleTimeoutMs: clampInt(
      readEnv(env, 'AIG_STREAM_IDLE_TIMEOUT_MS'),
      LIMITS.AIG_STREAM_IDLE_TIMEOUT_MS.min,
      LIMITS.AIG_STREAM_IDLE_TIMEOUT_MS.max,
      LIMITS.AIG_STREAM_IDLE_TIMEOUT_MS.def,
    ),
    rateLimitCooldownMs: clampInt(
      readEnv(env, 'AIG_RATE_LIMIT_COOLDOWN_MS'),
      LIMITS.AIG_RATE_LIMIT_COOLDOWN_MS.min,
      LIMITS.AIG_RATE_LIMIT_COOLDOWN_MS.max,
      LIMITS.AIG_RATE_LIMIT_COOLDOWN_MS.def,
    ),
    authFailCooldownMs: clampInt(
      readEnv(env, 'AIG_AUTH_FAILURE_COOLDOWN_MS'),
      LIMITS.AIG_AUTH_FAILURE_COOLDOWN_MS.min,
      LIMITS.AIG_AUTH_FAILURE_COOLDOWN_MS.max,
      LIMITS.AIG_AUTH_FAILURE_COOLDOWN_MS.def,
    ),
    maxBodyBytes: clampInt(
      readEnv(env, 'AIG_REQUEST_BODY_MAX_BYTES'),
      LIMITS.AIG_REQUEST_BODY_MAX_BYTES.min,
      LIMITS.AIG_REQUEST_BODY_MAX_BYTES.max,
      LIMITS.AIG_REQUEST_BODY_MAX_BYTES.def,
    ),
    failoverBudgetMs: clampInt(
      readEnv(env, 'AIG_FAILOVER_BUDGET_MS'),
      LIMITS.AIG_FAILOVER_BUDGET_MS.min,
      LIMITS.AIG_FAILOVER_BUDGET_MS.max,
      LIMITS.AIG_FAILOVER_BUDGET_MS.def,
    ),
    hedgeDelayMs: clampInt(
      readEnv(env, 'AIG_HEDGE_DELAY_MS'),
      LIMITS.AIG_HEDGE_DELAY_MS.min,
      LIMITS.AIG_HEDGE_DELAY_MS.max,
      LIMITS.AIG_HEDGE_DELAY_MS.def,
    ),
    isHedgeDelayExplicit: readEnv(env, 'AIG_HEDGE_DELAY_MS') !== undefined,
    maxHedgesPerRequest: maxHedgesFor(env),
    gatewayKeyRpm: clampInt(
      readEnv(env, 'AIG_ACCESS_KEY_RPM'),
      LIMITS.AIG_ACCESS_KEY_RPM.min,
      LIMITS.AIG_ACCESS_KEY_RPM.max,
      LIMITS.AIG_ACCESS_KEY_RPM.def,
    ),
    authAttemptRpm: clampInt(
      readEnv(env, 'AIG_AUTH_ATTEMPT_RPM'),
      LIMITS.AIG_AUTH_ATTEMPT_RPM.min,
      LIMITS.AIG_AUTH_ATTEMPT_RPM.max,
      LIMITS.AIG_AUTH_ATTEMPT_RPM.def,
    ),
    edgeCacheTtlSec: clampInt(
      readEnv(env, 'AIG_EDGE_CACHE_TTL_SEC'),
      LIMITS.AIG_EDGE_CACHE_TTL_SEC.min,
      LIMITS.AIG_EDGE_CACHE_TTL_SEC.max,
      costGuards ? 3_600 : LIMITS.AIG_EDGE_CACHE_TTL_SEC.def,
    ),
    tier1ProbeV2: getBool(env, 'AIG_TIER1_PROBE_V2', false),
    tier1ProbeTimeoutMs: clampInt(
      readEnv(env, 'AIG_TIER1_PROBE_TIMEOUT_MS'),
      LIMITS.AIG_TIER1_PROBE_TIMEOUT_MS.min,
      LIMITS.AIG_TIER1_PROBE_TIMEOUT_MS.max,
      LIMITS.AIG_TIER1_PROBE_TIMEOUT_MS.def,
    ),
    streamPassthrough: getBool(env, 'AIG_STREAM_PASSTHROUGH', false),
    streamGuardPrefixBytes: clampInt(
      readEnv(env, 'AIG_STREAM_GUARD_PREFIX_BYTES'),
      LIMITS.AIG_STREAM_GUARD_PREFIX_BYTES.min,
      LIMITS.AIG_STREAM_GUARD_PREFIX_BYTES.max,
      LIMITS.AIG_STREAM_GUARD_PREFIX_BYTES.def,
    ),
    conversionBudget: getBool(env, 'AIG_CONVERSION_BUDGET', false),
    conversionBudgetMode: conversionBudgetModeOf(env),
    conversionBudgetCfg: {
      maxEvents: clampInt(
        readEnv(env, 'AIG_CONVERSION_MAX_EVENTS'),
        LIMITS.AIG_CONVERSION_MAX_EVENTS.min,
        LIMITS.AIG_CONVERSION_MAX_EVENTS.max,
        LIMITS.AIG_CONVERSION_MAX_EVENTS.def,
      ),
      maxOutputUnits: clampInt(
        readEnv(env, 'AIG_CONVERSION_MAX_BYTES'),
        LIMITS.AIG_CONVERSION_MAX_BYTES.min,
        LIMITS.AIG_CONVERSION_MAX_BYTES.max,
        LIMITS.AIG_CONVERSION_MAX_BYTES.def,
      ),
      maxToolEvents: clampInt(
        readEnv(env, 'AIG_CONVERSION_MAX_TOOL_EVENTS'),
        LIMITS.AIG_CONVERSION_MAX_TOOL_EVENTS.min,
        LIMITS.AIG_CONVERSION_MAX_TOOL_EVENTS.max,
        LIMITS.AIG_CONVERSION_MAX_TOOL_EVENTS.def,
      ),
      maxToolArgUnits: clampInt(
        readEnv(env, 'AIG_CONVERSION_MAX_TOOL_ARG_BYTES'),
        LIMITS.AIG_CONVERSION_MAX_TOOL_ARG_BYTES.min,
        LIMITS.AIG_CONVERSION_MAX_TOOL_ARG_BYTES.max,
        LIMITS.AIG_CONVERSION_MAX_TOOL_ARG_BYTES.def,
      ),
    },
    conversionNonstreamMaxUnits: clampInt(
      readEnv(env, 'AIG_CONVERSION_NONSTREAM_MAX_BYTES'),
      LIMITS.AIG_CONVERSION_NONSTREAM_MAX_BYTES.min,
      LIMITS.AIG_CONVERSION_NONSTREAM_MAX_BYTES.max,
      LIMITS.AIG_CONVERSION_NONSTREAM_MAX_BYTES.def,
    ),
    conversionBudgetMaxTokens: clampInt(
      readEnv(env, 'AIG_CONVERSION_MAX_OUTPUT_TOKENS'),
      LIMITS.AIG_CONVERSION_MAX_OUTPUT_TOKENS.min,
      LIMITS.AIG_CONVERSION_MAX_OUTPUT_TOKENS.max,
      LIMITS.AIG_CONVERSION_MAX_OUTPUT_TOKENS.def,
    ),
    conversionPreferNonstream: getBool(env, 'AIG_CONVERSION_PREFER_NONSTREAM', false),
    requestAdmission: getBool(env, 'AIG_REQUEST_ADMISSION', false),
    isolateMaxInFlight: clampInt(
      readEnv(env, 'AIG_ISOLATE_MAX_IN_FLIGHT'),
      LIMITS.AIG_ISOLATE_MAX_IN_FLIGHT.min,
      LIMITS.AIG_ISOLATE_MAX_IN_FLIGHT.max,
      LIMITS.AIG_ISOLATE_MAX_IN_FLIGHT.def,
    ),
    chunkedBodyMaxBytes: clampInt(
      readEnv(env, 'AIG_CHUNKED_BODY_MAX_BYTES'),
      LIMITS.AIG_CHUNKED_BODY_MAX_BYTES.min,
      LIMITS.AIG_CHUNKED_BODY_MAX_BYTES.max,
      LIMITS.AIG_CHUNKED_BODY_MAX_BYTES.def,
    ),
    streamMaxAttempts: clampInt(
      readEnv(env, 'AIG_STREAM_MAX_ATTEMPTS'),
      LIMITS.AIG_STREAM_MAX_ATTEMPTS.min,
      LIMITS.AIG_STREAM_MAX_ATTEMPTS.max,
      LIMITS.AIG_STREAM_MAX_ATTEMPTS.def,
    ),
    nonStreamMaxAttempts: clampInt(
      readEnv(env, 'AIG_NONSTREAM_MAX_ATTEMPTS'),
      LIMITS.AIG_NONSTREAM_MAX_ATTEMPTS.min,
      LIMITS.AIG_NONSTREAM_MAX_ATTEMPTS.max,
      LIMITS.AIG_NONSTREAM_MAX_ATTEMPTS.def,
    ),
    tier1AffinityWrite:
      readEnv(env, 'AIG_AFFINITY_WRITE') !== undefined
        ? clampInt(
            readEnv(env, 'AIG_AFFINITY_WRITE'),
            LIMITS.AIG_AFFINITY_WRITE.min,
            LIMITS.AIG_AFFINITY_WRITE.max,
            LIMITS.AIG_AFFINITY_WRITE.def,
          ) === 1
        : !costGuards,
    tokenD1SamplePct: clampInt(
      readEnv(env, 'AIG_TOKEN_D1_SAMPLE_PCT'),
      LIMITS.AIG_TOKEN_D1_SAMPLE_PCT.min,
      LIMITS.AIG_TOKEN_D1_SAMPLE_PCT.max,
      costGuards ? 1 : LIMITS.AIG_TOKEN_D1_SAMPLE_PCT.def,
    ),
    logLevelDefault: costGuards ? 'warn' : 'info',
    hotPathGuards,
    affinityReadTimeoutMs: clampInt(
      readEnv(env, 'AIG_AFFINITY_READ_TIMEOUT_MS'),
      LIMITS.AIG_AFFINITY_READ_TIMEOUT_MS.min,
      LIMITS.AIG_AFFINITY_READ_TIMEOUT_MS.max,
      hotPathGuards ? 15 : LIMITS.AIG_AFFINITY_READ_TIMEOUT_MS.def,
    ),
  };
  cache.set(cacheKey, cached);
  return cached;
}

export function clampRetryAfterMs(ms: number): number {
  return Math.min(Math.max(Math.round(ms), RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

export function parseRetryAfterMs(headers: Headers, now: number = Date.now(), maxMs: number = RETRY_AFTER_MAX_MS): number {
  const value = headers?.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(Math.round(seconds * 1000), RETRY_AFTER_MIN_MS), maxMs);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(dateMs - now, RETRY_AFTER_MIN_MS), maxMs);
  }
  return 0;
}
