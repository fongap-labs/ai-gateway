// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Single source of truth for every non-sensitive runtime variable the
// gateway recognizes. The deployment bridge (github-deployment-config.mjs)
// derives its allowlist from this registry; the timeout loader
// (timeouts.ts) derives its clamp limits from the int entries; docs and
// example configs reference the same names.
//
// Sensitive values (AIG_ACCESS_KEY_<GROUP>, TIER*_CREDENTIALS_*, AIG_TOKEN_ENCRYPTION_KEY,
// CLOUDFLARE_API_TOKEN) are NOT listed here - they are Secrets, never plain Worker variables.
//
// CLOUDFLARE_ACCOUNT_ID and AIG_USAGE_D1_ID are deployment identifiers.
// AIG_PUBLIC_URL is deployment-owned runtime metadata used by the dashboard;
// the deployment bridge passes it through separately from runtime tunables.

export interface RuntimeTunable {
  name: string;
  type: 'int';
  min: number;
  max: number;
  def: number;
}

export interface RuntimeStringVar {
  name: string;
  def: string;
}

export interface RuntimeBoolVar {
  name: string;
  def: boolean;
}

export const RUNTIME_TUNABLES = [
  { name: 'AIG_UPSTREAM_HEADER_TIMEOUT_MS', type: 'int', min: 5_000, max: 600_000, def: 15_000 },
  { name: 'AIG_FIRST_EVENT_TIMEOUT_MS', type: 'int', min: 5_000, max: 600_000, def: 30_000 },
  { name: 'AIG_STREAM_IDLE_TIMEOUT_MS', type: 'int', min: 10_000, max: 600_000, def: 120_000 },
  { name: 'AIG_RATE_LIMIT_COOLDOWN_MS', type: 'int', min: 1_000, max: 600_000, def: 30_000 },
  { name: 'AIG_AUTH_FAILURE_COOLDOWN_MS', type: 'int', min: 60_000, max: 7 * 86_400_000, def: 3_600_000 },
  // The body is held as text, then parsed into objects and possibly copied
  // again for conversion. A Worker has ~128 MB of memory, so 32 MB is the
  // practical ceiling; 20 MB remains the default.
  { name: 'AIG_REQUEST_BODY_MAX_BYTES', type: 'int', min: 1024, max: 32 * 1024 * 1024, def: 20 * 1024 * 1024 },
  { name: 'AIG_FAILOVER_BUDGET_MS', type: 'int', min: 1_000, max: 900_000, def: 60_000 },
  { name: 'AIG_HEDGE_DELAY_MS', type: 'int', min: 0, max: 600_000, def: 3_000 },
  { name: 'AIG_REQUEST_HEDGE_MAX', type: 'int', min: 0, max: 3, def: 1 },
  // (AIG_REQUEST_ADMISSION) Per-isolate cap on concurrent body-carrying
  // requests. Each admission starts streams that share the isolate's CPU and
  // its ~128MB; a burst must not starve in-flight streams to the point where
  // the isolate is recycled with all learned state. Bodyless requests
  // (health, metrics, dashboard) are never refused for this. 0 disables.
  { name: 'AIG_ISOLATE_MAX_IN_FLIGHT', type: 'int', min: 0, max: 512, def: 32 },
  // (AIG_REQUEST_ADMISSION) Worst-case charge AND read ceiling for a request
  // body without a usable Content-Length (chunked transfer): its true size is
  // unknowable before reading, but charging AIG_REQUEST_BODY_MAX_BYTES (20MB)
  // per chunked request would admit almost none once the 32MB in-flight budget
  // is busy. The read in preflight is bounded by the same value, so the charge
  // stays a true worst case at a fraction of the full-body cap. Bodies WITH a
  // Content-Length keep the declared charge and the full-body read ceiling.
  { name: 'AIG_CHUNKED_BODY_MAX_BYTES', type: 'int', min: 16_384, max: 32 * 1024 * 1024, def: 524_288 },
  // (AIG_REQUEST_ADMISSION) Logical-attempt ceilings per streaming mode. A wide
  // failover plan fans out into the whole node pool — each attempt bills at
  // least one upstream dispatch — and a streaming attempt cannot retry after
  // the client stream is committed. New-mode defaults: 2 for streaming, 3 for
  // buffered requests; raise these to re-widen explicit policies.
  { name: 'AIG_STREAM_MAX_ATTEMPTS', type: 'int', min: 1, max: 8, def: 2 },
  { name: 'AIG_NONSTREAM_MAX_ATTEMPTS', type: 'int', min: 1, max: 8, def: 3 },
  // Per-isolate, per-key RPM cap. Counts request-START moments in a
  // 60s sliding window. The cap is best-effort (single-isolate); a strict
  // global cap across isolates needs a Cloudflare WAF rate-limiting rule in
  // front of the Worker (see src/ratelimit/key-rpm.ts).
  // 0 disables the cap entirely (default). Set a positive value to cap each key group.
  { name: 'AIG_ACCESS_KEY_RPM', type: 'int', min: 0, max: 100_000, def: 0 },
  // Per-isolate, per-fingerprint cap on FAILED authorization attempts in a 60s
  // sliding window. Checked before authorize(); only failures are counted, and a
  // successful authorization clears the fingerprint. 0 disables the throttle.
  { name: 'AIG_AUTH_ATTEMPT_RPM', type: 'int', min: 0, max: 100_000, def: 60 },
  // Edge idempotent-cache TTL for zero-temperature (or x-gateway-cache
  // opt-in) inference requests. Stored through the Cloudflare Cache API at
  // the edge colo; a HIT replays the exact client-facing response with zero
  // upstream consumption. 0 disables the edge cache entirely (match and put
  // are skipped), matching the AIG_ACCESS_KEY_RPM disable convention.
  { name: 'AIG_EDGE_CACHE_TTL_SEC', type: 'int', min: 0, max: 7 * 86_400, def: 14_400 },
  // (AIG_COST_GUARDS) Percent of token-usage events persisted into the D1
  // aggregate (delivered + upstream views both). 100 keeps every event; the
  // guard stack switches the DEFAULT to 1%. Sampling applies to the D1 writes
  // only: the isolate-local /metrics counters and node token statistics stay
  // exact, and the D1 aggregate becomes an explicitly sampled basis (never
  // extrapolated), which frees write cadence on the Free plan's 100k writes/day.
  // 0 disables D1 token persistence entirely.
  { name: 'AIG_TOKEN_D1_SAMPLE_PCT', type: 'int', min: 0, max: 100, def: 100 },
  // (AIG_COST_GUARDS) KV Tier 1 session-affinity writes. 1 (default) keeps the
  // binding write; the guard stack switches the DEFAULT to 0 — it is a soft
  // score bias whose write volume otherwise competes with the Free plan's
  // 1,000 KV writes/day. Explicit values always win on both sides.
  { name: 'AIG_AFFINITY_WRITE', type: 'int', min: 0, max: 1, def: 1 },
  // (AIG_HOT_PATH_GUARDS) How long one request waits for a cold Tier 1
  // session-affinity KV read before treating the binding as unknown. Affinity
  // is a soft score bias, so the legacy 50ms paid a cold-KV tail on the first
  // token path; the guard stack switches the DEFAULT to 15ms. The read itself
  // continues in the background and warms the isolate cache for the next
  // request. Under AIG_HOT_PATH_GUARDS the read path also gains an
  // isolate-local breaker (see scheduler/tier1-affinity.ts): repeated timeouts
  // stop issuing reads for a cooldown instead of paying the tail per request.
  { name: 'AIG_AFFINITY_READ_TIMEOUT_MS', type: 'int', min: 1, max: 1_000, def: 50 },
  // (AIG_TIER1_PROBE_V2) How long an armed Tier 1 recovery probe holds its
  // single-flight window before the gate self-opens. The probe itself commits as
  // soon as the first meaningful evidence arrives (response headers for a
  // buffered reply, the first SSE event for a stream), so a healthy key reopens
  // in about one round trip instead of holding every other request behind the
  // whole window. Under the legacy gate (AIG_TIER1_PROBE_V2 off) this value is
  // unused; the classic fixed 15s window keeps its dedicated constant.
  { name: 'AIG_TIER1_PROBE_TIMEOUT_MS', type: 'int', min: 5_000, max: 30_000, def: 10_000 },
  // (AIG_STREAM_PASSTHROUGH) Byte budget the first-event guard may absorb while
  // waiting for the first meaningful SSE event before it gives up. The legacy
  // guard keeps its dedicated 2MB constant; only the pass-through relay mode
  // uses this smaller cap (64KB), so a prefix-only provider cannot make the
  // isolate buffer megabytes before the first event is observed.
  { name: 'AIG_STREAM_GUARD_PREFIX_BYTES', type: 'int', min: 16_384, max: 2 * 1024 * 1024, def: 65_536 },
  // (AIG_CONVERSION_BUDGET) Per-request ceiling on IR translation work for one
  // matrix-converted reply: max decoded events, translated output characters,
  // tool-call events, cumulative argument length of one open tool call, and
  // reported output tokens. Cross-protocol replies are small by demand; a
  // runaway generation (misconfigured max_tokens, a looping model) otherwise
  // translates unbounded CPU inside the isolate. Units: counts; lengths in
  // UTF-16 code units (~byte equivalent for ASCII). Ignored entirely while the
  // AIG_CONVERSION_BUDGET flag is off.
  { name: 'AIG_CONVERSION_MAX_EVENTS', type: 'int', min: 25, max: 100_000, def: 400 },
  { name: 'AIG_CONVERSION_MAX_BYTES', type: 'int', min: 4_096, max: 4 * 1024 * 1024, def: 131_072 },
  { name: 'AIG_CONVERSION_MAX_TOOL_EVENTS', type: 'int', min: 2, max: 100_000, def: 200 },
  { name: 'AIG_CONVERSION_MAX_TOOL_ARG_BYTES', type: 'int', min: 1_024, max: 1024 * 1024, def: 65_536 },
  // The same output ceiling for the collected-object path (a non-streaming
  // client over a forced-stream upstream), which accumulates the decoded reply
  // in memory before rendering.
  { name: 'AIG_CONVERSION_NONSTREAM_MAX_BYTES', type: 'int', min: 4_096, max: 4 * 1024 * 1024, def: 131_072 },
  // Reported cumulative output-token ceiling. Anthropic reports running output
  // tokens mid-stream, so this can cut a live stream; Chat/Responses report
  // once at the end. 0 disables the token ceiling entirely (default).
  { name: 'AIG_CONVERSION_MAX_OUTPUT_TOKENS', type: 'int', min: 0, max: 10_000_000, def: 0 },
] as const satisfies readonly RuntimeTunable[];

export type RuntimeTunableName = (typeof RUNTIME_TUNABLES)[number]['name'];

// Diagnostics expose node state and the deployment build, so by default only the
// two most privileged key groups read them.
export const DIAGNOSTICS_GROUPS_DEFAULT = 'MAX,ULTRA';

export const RUNTIME_STRING_VARS: RuntimeStringVar[] = [
  { name: 'AIG_CORS_ORIGIN', def: '' },
  { name: 'AIG_USAGE_INCLUDE_MODE', def: 'auto' },
  { name: 'AIG_USAGE_EXCLUDE_PROVIDERS', def: '' },
  { name: 'AIG_ANTHROPIC_COUNT_MODE', def: 'approximate' },
  { name: 'AIG_LOG_LEVEL', def: 'info' },
  { name: 'AIG_PROTOCOL_FALLBACKS', def: '' },
  { name: 'AIG_DASHBOARD_MODELS', def: '' },
  // Tier 1 429 cooldown ladder in milliseconds, comma separated ("15000,30000,60000,...").
  // Empty keeps the built-in ladder (15s, 30s, 1m, 2m, 5m, 10m, 20m, 30m).
  { name: 'AIG_RATE_LIMIT_STEPS_MS', def: '' },
  // Short-window variant of the 429 ladder, for minute-style limits (rpm/tpm),
  // capped at 5 minutes: "15000,30000,45000,60000,90000,120000,180000,300000".
  // Empty keeps the built-in window ladder.
  { name: 'AIG_RATE_LIMIT_WINDOW_STEPS_MS', def: '' },
  // Long-allowance variant of the 429 ladder, for hourly/daily plan windows
  // (a 5-hour coding plan, a daily cap): "300000,600000,1200000,1800000".
  // Empty keeps the built-in ladder (5m ... 30m).
  { name: 'AIG_RATE_LIMIT_QUOTA_STEPS_MS', def: '' },
  // Tier 2 subscription OAuth provider registry: JSON object keyed by
  // provider name -> { authorize_url, token_url, client_id, scope,
  // upstream_headers? }. Unset disables all subscription onboarding and
  // resolution (fail-closed). See docs/operations/configuration.md.
  { name: 'AIG_OAUTH_PROVIDERS', def: '' },
  // Access-key groups allowed to start Tier 2 subscription onboarding, comma
  // separated ("ULTRA" or "ULTRA,AGENT"). Unset disables onboarding
  // (fail-closed); already linked subscriptions keep working.
  { name: 'AIG_OAUTH_ADMIN_GROUPS', def: '' },
  // AIG_OAUTH_ADMIN_GROUPS listing...
  { name: 'AIG_OAUTH_ADMIN_GROUPS', def: '' },
  // What the translation matrix does when a reply exceeds the AIG_CONVERSION_*
  // budget (AIG_CONVERSION_BUDGET must be on). "error" (default) ends the
  // stream with a gateway error frame (or 502 for object collection); "truncate"
  // renders a well-formed short reply instead (finish_reason length /
  // stop_reason max_tokens / response.incomplete) — the attempt is delivered,
  // counted, and settled like any other success.
  { name: 'AIG_CONVERSION_BUDGET_MODE', def: 'error' },
  // Access-key groups allowed to read /health and /metrics, comma separated ("AGENT" or
  // "AGENT,ULTRA"); "*" lets every valid key read them.
  { name: 'AIG_DIAGNOSTICS_GROUPS', def: DIAGNOSTICS_GROUPS_DEFAULT },
];

export const RUNTIME_BOOL_VARS: RuntimeBoolVar[] = [
  { name: 'AIG_SHOULD_EXPOSE_UPSTREAM', def: false },
  { name: 'AIG_HAS_STREAM_GUARD', def: false },
  { name: 'AIG_CAN_USE_HTTP', def: false },
  // Serve the public dashboard at / and the README status badge. false answers both with 404.
  // The dashboard never lists access-key group names.
  { name: 'AIG_PUBLIC_DASHBOARD', def: true },
  // Tier 2 subscription proxying (auth:"oauth" nodes and /oauth/* onboarding). false loads no
  // subscription node and answers /oauth/* with 404. See SECURITY.md before enabling.
  { name: 'AIG_IS_SUBSCRIPTION_ENABLED', def: true },
  // Cache temperature=0 requests without the x-gateway-cache: true opt-in. Off by default.
  { name: 'AIG_EDGE_CACHE_AUTO', def: false },
  // v2 Tier 1 rate-limit recovery gate. false keeps the legacy behavior: a
  // 15s account-wide (or model-wide) hard gate after each 429 cooldown expires,
  // with the recovery probe committed only at stream end. true replaces the
  // hard gate with a single-flight probe that other requests do not queue
  // behind: concurrent claims skip to another node, and the probe commits at
  // response headers / first SSE event.
  { name: 'AIG_TIER1_PROBE_V2', def: false },
  // Pass-through native stream relay. false keeps the tracked relay (per-chunk
  // decode + completion/usage/error scans + optional model rewrite). true moves
  // every chunk byte-for-byte from the upstream to the client with no per-chunk
  // scanning: no delivered usage, no model rewrite, no completion-marker or
  // failure inference (a truncated stream that ends with a clean EOF is
  // accounted as delivered), no synthetic interruption events. Idle timeout and
  // cancel propagation stay active.
  { name: 'AIG_STREAM_PASSTHROUGH', def: false },
  // Per-request budget enforcement for matrix (cross-protocol) conversions.
  // false (default) keeps the legacy unlimited translation byte-for-byte. true
  // applies the AIG_CONVERSION_* ceilings: when exceeded, behavior is governed
  // by AIG_CONVERSION_BUDGET_MODE. The node receives no reliability blame
  // either way: the reply size is the client's demand, not the key's health.
  { name: 'AIG_CONVERSION_BUDGET', def: false },
  // Non-streaming clients keep their own stream flag for matrix conversions so
  // the upstream may answer with a single JSON body (avoids SSE parsing and,
  // for several providers, accounts cheaper). false (default) keeps the forced
  // upstream streaming + collect path. Streaming clients always upstream-stream
  // regardless of this flag.
  { name: 'AIG_CONVERSION_PREFER_NONSTREAM', def: false },
  // Request-admission / isolation guards (action: request admission). false
  // (default) keeps the legacy admission byte-for-byte: no isolate concurrency
  // cap, chunked bodies charged and read at AIG_REQUEST_BODY_MAX_BYTES, the
  // resolved policy's max_attempts, and an AIG_REQUEST_HEDGE_MAX default of 1.
  // true enables: AIG_ISOLATE_MAX_IN_FLIGHT, the AIG_CHUNKED_BODY_MAX_BYTES
  // charge/read cap for Content-Length-less bodies, per-mode logical-attempt
  // ceilings (AIG_STREAM_MAX_ATTEMPTS / AIG_NONSTREAM_MAX_ATTEMPTS), and
  // switches the AIG_REQUEST_HEDGE_MAX DEFAULT from 1 to 0 (an explicitly set
  // AIG_REQUEST_HEDGE_MAX always wins on both sides of the flag).
  { name: 'AIG_REQUEST_ADMISSION', def: false },
  // Observability / persistence cost guards. false (default) keeps every
  // documented default byte-for-byte: KV affinity writes ON, every token-usage
  // event persisted to D1, a 4h edge-cache TTL, and AIG_LOG_LEVEL defaulting
  // to info. true switches those four DEFAULTS (explicit values always win on
  // both sides): AIG_AFFINITY_WRITE -> 0, AIG_TOKEN_D1_SAMPLE_PCT -> 1,
  // AIG_EDGE_CACHE_TTL_SEC -> 0 (off), AIG_LOG_LEVEL -> warn.
  { name: 'AIG_COST_GUARDS', def: false },
  // Main-path CPU guards. false (default) keeps the legacy hot path
  // byte-for-byte: the failed-auth throttle fingerprints (SHA-256) every
  // request, the diagnostics bundle is imported on every request path, and an
  // affinity KV read waits the legacy 50ms. true makes the fingerprint lazy
  // (only when the throttle has state to consult or the attempt fails), loads
  // the diagnostics bundle only for /health, /metrics and /models, and moves
  // the affinity read wait to AIG_AFFINITY_READ_TIMEOUT_MS (default 15) behind
  // an isolate-local breaker.
  { name: 'AIG_HOT_PATH_GUARDS', def: false },
];

// Every non-sensitive runtime variable name, for the deployment bridge.
export const RUNTIME_VAR_NAMES: string[] = [
  ...RUNTIME_TUNABLES.map((v) => v.name),
  ...RUNTIME_STRING_VARS.map((v) => v.name),
  ...RUNTIME_BOOL_VARS.map((v) => v.name),
];
