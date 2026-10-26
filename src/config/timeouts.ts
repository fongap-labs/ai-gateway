// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Single source of truth for every timeout / cooldown value.
// Do not hardcode timeout defaults anywhere else.

import { clampInt, getBool, readEnv } from './env.ts';
import type { RuntimeTunableName } from './runtime-vars.ts';
import { RUNTIME_TUNABLES } from './runtime-vars.ts';

// Derived from the single source of truth in runtime-vars.ts. Do not add
// tunable definitions here — add them there so the deployment bridge, docs
// and example configs stay in sync automatically.
const LIMITS = Object.fromEntries(RUNTIME_TUNABLES.map((v) => [v.name, { min: v.min, max: v.max, def: v.def }])) as Record<
  RuntimeTunableName,
  { min: number; max: number; def: number }
>;

// Retry-After is always clamped into this window so a hostile or broken
// upstream cannot park a node for hours via one header.
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 600_000;
// A 429 that names a long-lived allowance (an hourly plan window, a daily cap)
// states a wait of hours, and clamping that to ten minutes only buys a futile
// probe every ten minutes. Once a response is known to be such an allowance its
// wait is honoured up to this ceiling (the same ceiling subscription reset hints
// use), which still stops a broken upstream from parking a key for days.
export const QUOTA_RETRY_AFTER_MAX_MS = 6 * 3_600_000;

// Floors for phase-local waits. These are not request-wide admission limits;
// the absolute attempt deadline and remaining request budget still win.
export const MIN_ATTEMPT_HEADERS_MS = 20_000;
export const MIN_ATTEMPT_FIRST_EVENT_MS = 5_000;

// Reserve a small escape window for each later logical attempt instead of
// dividing the whole request budget evenly up front. Five seconds is enough
// for a healthy alternate to fail fast or begin producing output. When the
// whole request budget is tighter, the reserve automatically shrinks to the
// equal-share value so later candidates are never starved completely.
export const MIN_FAILOVER_RESERVE_MS = 5_000;

// Prefill time grows with prompt size: a coding agent sending a few hundred
// thousand characters of context legitimately waits tens of seconds for the first
// token, and a timeout tuned for a short chat turn kills that healthy upstream,
// fails over to an equally slow one and ends in a 504. The base timeouts and the
// failover budget therefore grow by one second per SIZE_ALLOWANCE_CHARS_PER_SEC
// characters above SIZE_ALLOWANCE_FREE_CHARS, up to SIZE_ALLOWANCE_MAX_MS.
export const SIZE_ALLOWANCE_FREE_CHARS = 50_000;
export const SIZE_ALLOWANCE_CHARS_PER_SEC = 25_000;
export const SIZE_ALLOWANCE_MAX_MS = 45_000;

export function requestSizeAllowanceMs(bodyChars: number | undefined | null): number {
  if (typeof bodyChars !== 'number' || !Number.isFinite(bodyChars) || bodyChars <= SIZE_ALLOWANCE_FREE_CHARS) return 0;
  const allowance = Math.floor(((bodyChars - SIZE_ALLOWANCE_FREE_CHARS) / SIZE_ALLOWANCE_CHARS_PER_SEC) * 1_000);
  return Math.min(SIZE_ALLOWANCE_MAX_MS, allowance);
}

// A reactive hedge duplicates the request on a second key. The built-in delay is
// a floor for short chat turns; a prompt that is known to be slow (large body, or
// a primary whose observed TTFT is already long) must not be hedged on nearly
// every call, which would double upstream load and burn rate-limit headroom on
// requests that were healthy. An operator-set delay is never adapted.
export const HEDGE_ADAPTIVE_MAX_MS = 20_000;
// A buffered (non-stream) reply cannot commit before generation ends, so a hedge
// earlier than this would fire on nearly every such request.
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
  /** True when the operator set AIG_HEDGE_DELAY_MS; an explicit delay is never adapted. */
  isHedgeDelayExplicit: boolean;
  maxHedgesPerRequest: number;
  gatewayKeyRpm: number;
  authAttemptRpm: number;
  edgeCacheTtlSec: number;
  /** AIG_TIER1_PROBE_V2: single-flight recovery probe that commits early
   *  (headers / first SSE event) instead of a 15s hard gate whose probe only
   *  commits at stream end. false keeps the legacy gate byte-for-byte. */
  tier1ProbeV2: boolean;
  /** AIG_TIER1_PROBE_TIMEOUT_MS: how long the v2 probe keeps its single-flight
   *  window when no meaningful evidence arrives. Unused legacy mode. */
  tier1ProbeTimeoutMs: number;
  /** AIG_STREAM_PASSTHROUGH: byte-for-byte native stream relay with no
   *  per-chunk scanning. false keeps the tracked relay. */
  streamPassthrough: boolean;
  /** AIG_STREAM_GUARD_PREFIX_BYTES: pre-event byte budget for the guard in
   *  pass-through mode. Unused legacy mode (2MB constant). */
  streamGuardPrefixBytes: number;
  /** AIG_CONVERSION_BUDGET: per-request ceilings on matrix translation work.
   *  false keeps the legacy unlimited translation. */
  conversionBudget: boolean;
  /** AIG_CONVERSION_BUDGET_MODE: what happens when a reply exceeds the budget.
   *  "error" ends with a gateway error frame / 502; "truncate" delivers a
   *  well-formed shortened reply and counts the attempt as delivered. */
  conversionBudgetMode: 'error' | 'truncate';
  /** Numeric ceilings for streaming translation (see MatrixConversionBudget). */
  conversionBudgetCfg: {
    maxEvents: number;
    maxOutputUnits: number;
    maxToolEvents: number;
    maxToolArgUnits: number;
  };
  /** Output ceiling for the collected-object path. */
  conversionNonstreamMaxUnits: number;
  /** Reported output-token ceiling; 0 disables. */
  conversionBudgetMaxTokens: number;
  /** AIG_CONVERSION_PREFER_NONSTREAM: non-streaming clients keep their own
   *  stream flag so cross-protocol requests may hit the upstream non-streaming. */
  conversionPreferNonstream: boolean;
  /** AIG_REQUEST_ADMISSION: request-admission / isolation guard stack. false
   *  keeps the legacy admission byte-for-byte. */
  requestAdmission: boolean;
  /** AIG_ISOLATE_MAX_IN_FLIGHT: per-isolate cap on concurrent body-carrying
   *  requests; 0 disables. */
  isolateMaxInFlight: number;
  /** AIG_CHUNKED_BODY_MAX_BYTES: admission charge and read ceiling for bodies
   *  without a usable Content-Length. Unused legacy mode (full-body cap). */
  chunkedBodyMaxBytes: number;
  /** AIG_STREAM_MAX_ATTEMPTS / AIG_NONSTREAM_MAX_ATTEMPTS: logical-attempt
   *  ceilings per streaming mode. Unused legacy mode. */
  streamMaxAttempts: number;
  nonStreamMaxAttempts: number;
  /** Whether Tier 1 session-affinity KV writes are enabled. Legacy default on;
   *  AIG_COST_GUARDS switches the default off. */
  tier1AffinityWrite: boolean;
  /** AIG_TOKEN_D1_SAMPLE_PCT: percent of token-usage events persisted into the
   *  D1 aggregate (isolate counters stay exact). Legacy default 100. */
  tokenD1SamplePct: number;
  /** Default edge-cache TTL when AIG_EDGE_CACHE_TTL_SEC is unset. Legacy 4h;
   *  AIG_COST_GUARDS switches the default off. */
  edgeCacheTtlDefaultSec: number;
  /** Default log level when AIG_LOG_LEVEL is unset. Legacy info; AIG_COST_GUARDS
   *  switches the default to warn. */
  logLevelDefault: string;
};

// Legacy/equal-share primitive retained as a pure helper. Some tests and
// isolated callers intentionally reason about an even split. The live request
// path uses attemptBudgetWindowMs below so the preferred candidate is not
// prematurely killed merely because several fallback candidates exist.
export function attemptBudgetSliceMs(remainingBudgetMs: number, remainingAttempts: number): number {
  const attempts = Math.max(1, Math.trunc(remainingAttempts) || 1);
  return Math.max(1, Math.floor(Math.max(0, remainingBudgetMs) / attempts));
}

// Allocate the current logical attempt's absolute wall-clock window.
//
// The previous live path used equal-share slicing directly. With the default
// 60s request budget and 5 possible attempts, that reduced the first candidate
// to ~12s total for BOTH headers and first meaningful output. A healthy
// coding/reasoning model could therefore be timed out long before its
// configured AIG_FIRST_EVENT_TIMEOUT_MS.
//
// Reserve-aware allocation lets the current candidate use the remaining
// request budget except for a small reserve per later candidate. Phase-local
// header/first-event timers still cap actual waiting, and the hedge twin shares
// the same absolute deadline. When budget is tight, reservePerLater collapses
// to the equal-share value, preserving a viable tail instead of front-loading
// everything into the first attempt.
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

// Phase-local response-header wait. Dispatch passes one already allocated
// attempt window here, so the configured header timeout is preserved unless
// the absolute attempt/request budget is tighter. The multi-attempt form is
// retained for isolated callers/tests.
export function attemptHeadersTimeoutMs(headersTimeoutMs: number, remainingBudgetMs: number, remainingAttempts: number): number {
  return fairShareTimeoutMs(headersTimeoutMs, remainingBudgetMs, remainingAttempts, MIN_ATTEMPT_HEADERS_MS);
}

// Phase-local first-event guard. It consumes only the time left in the same
// absolute attempt window after headers, and never exceeds the configured
// first-event timeout. Primary and hedge twin share that same deadline.
export function attemptFirstEventTimeoutMs(firstEventTimeoutMs: number, remainingBudgetMs: number, remainingAttempts: number): number {
  return fairShareTimeoutMs(firstEventTimeoutMs, remainingBudgetMs, remainingAttempts, MIN_ATTEMPT_FIRST_EVENT_MS);
}

const cache = new WeakMap<object, Limits>();

/** AIG_CONVERSION_BUDGET_MODE pick, fail-safe to "error" on any unknown value. */
function conversionBudgetModeOf(env: Record<string, unknown>): 'error' | 'truncate' {
  return readEnv(env, 'AIG_CONVERSION_BUDGET_MODE')?.toLowerCase() === 'truncate' ? 'truncate' : 'error';
}

/**
 * AIG_REQUEST_HEDGE_MAX: an explicitly set value always wins (both sides of
 * the AIG_REQUEST_ADMISSION flag). When unset, the default depends on the
 * flag: the admission stack wants hedges off by default — every hedge is a
 * bonus upstream dispatch whose bill lands regardless of who wins the race —
 * while the legacy mode keeps its documented default of 1.
 */
function maxHedgesFor(env: Record<string, unknown>): number {
  const raw = readEnv(env, 'AIG_REQUEST_HEDGE_MAX');
  if (raw !== undefined) {
    return clampInt(raw, LIMITS.AIG_REQUEST_HEDGE_MAX.min, LIMITS.AIG_REQUEST_HEDGE_MAX.max, LIMITS.AIG_REQUEST_HEDGE_MAX.def);
  }
  return getBool(env, 'AIG_REQUEST_ADMISSION', false) ? 0 : LIMITS.AIG_REQUEST_HEDGE_MAX.def;
}

export function getLimits(env: Record<string, unknown>): Limits {
  let cached = cache.get(env);
  if (cached) return cached;
  // AIG_COST_GUARDS switches observable-default VALUES only (never clamps an
  // explicit override); see each derived field below.
  const costGuards = getBool(env, 'AIG_COST_GUARDS', false);
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
      LIMITS.AIG_EDGE_CACHE_TTL_SEC.def,
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
      maxEvents: clampInt(readEnv(env, 'AIG_CONVERSION_MAX_EVENTS'), LIMITS.AIG_CONVERSION_MAX_EVENTS.min, LIMITS.AIG_CONVERSION_MAX_EVENTS.max, LIMITS.AIG_CONVERSION_MAX_EVENTS.def),
      maxOutputUnits: clampInt(readEnv(env, 'AIG_CONVERSION_MAX_BYTES'), LIMITS.AIG_CONVERSION_MAX_BYTES.min, LIMITS.AIG_CONVERSION_MAX_BYTES.max, LIMITS.AIG_CONVERSION_MAX_BYTES.def),
      maxToolEvents: clampInt(readEnv(env, 'AIG_CONVERSION_MAX_TOOL_EVENTS'), LIMITS.AIG_CONVERSION_MAX_TOOL_EVENTS.min, LIMITS.AIG_CONVERSION_MAX_TOOL_EVENTS.max, LIMITS.AIG_CONVERSION_MAX_TOOL_EVENTS.def),
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
        ? clampInt(readEnv(env, 'AIG_AFFINITY_WRITE'), LIMITS.AIG_AFFINITY_WRITE.min, LIMITS.AIG_AFFINITY_WRITE.max, LIMITS.AIG_AFFINITY_WRITE.def) === 1
        : !costGuards,
    tokenD1SamplePct: clampInt(
      readEnv(env, 'AIG_TOKEN_D1_SAMPLE_PCT'),
      LIMITS.AIG_TOKEN_D1_SAMPLE_PCT.min,
      LIMITS.AIG_TOKEN_D1_SAMPLE_PCT.max,
      costGuards ? 1 : LIMITS.AIG_TOKEN_D1_SAMPLE_PCT.def,
    ),
    edgeCacheTtlDefaultSec: costGuards ? 0 : 14_400,
    logLevelDefault: costGuards ? 'warn' : 'info',
  };
  cache.set(env, cached);
  return cached;
}

// Parse a Retry-After header. Supports delay-seconds and HTTP-date forms.
/** Clamp a provider-suggested wait into the window every Retry-After style hint obeys. */
export function clampRetryAfterMs(ms: number): number {
  return Math.min(Math.max(Math.round(ms), RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

// Returns milliseconds clamped to [RETRY_AFTER_MIN_MS, maxMs], or 0 when absent/invalid.
// maxMs defaults to the ordinary 10-minute ceiling.
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
