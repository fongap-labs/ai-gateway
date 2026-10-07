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
  { name: 'AIG_REQUEST_BODY_MAX_BYTES', type: 'int', min: 1024, max: 100 * 1024 * 1024, def: 20 * 1024 * 1024 },
  { name: 'AIG_FAILOVER_BUDGET_MS', type: 'int', min: 1_000, max: 900_000, def: 60_000 },
  { name: 'AIG_HEDGE_DELAY_MS', type: 'int', min: 0, max: 600_000, def: 3_000 },
  { name: 'AIG_REQUEST_HEDGE_MAX', type: 'int', min: 0, max: 3, def: 1 },
  // Per-isolate, per-key RPM cap. Counts request-START moments in a
  // 60s sliding window. The cap is best-effort (single-isolate); for a
  // strict global cap across isolates, bind a Cloudflare Rate Limiting
  // worker binding (this is the existing model, see QUOTA_RATE_LIMITER).
  // 0 disables the cap entirely (default for backward compatibility).
  { name: 'AIG_ACCESS_KEY_RPM', type: 'int', min: 0, max: 100_000, def: 0 },
  // Edge idempotent-cache TTL for zero-temperature (or x-gateway-cache
  // opt-in) inference requests. Stored through the Cloudflare Cache API at
  // the edge colo; a HIT replays the exact client-facing response with zero
  // upstream consumption. 0 disables the edge cache entirely (match and put
  // are skipped), matching the AIG_ACCESS_KEY_RPM disable convention.
  { name: 'AIG_EDGE_CACHE_TTL_SEC', type: 'int', min: 0, max: 7 * 86_400, def: 14_400 },
] as const satisfies readonly RuntimeTunable[];

export type RuntimeTunableName = (typeof RUNTIME_TUNABLES)[number]['name'];

export const RUNTIME_STRING_VARS: RuntimeStringVar[] = [
  { name: 'AIG_CORS_ORIGIN', def: '' },
  { name: 'AIG_USAGE_INCLUDE_MODE', def: 'auto' },
  { name: 'AIG_USAGE_EXCLUDE_PROVIDERS', def: '' },
  { name: 'AIG_ANTHROPIC_COUNT_MODE', def: 'approximate' },
  { name: 'AIG_LOG_LEVEL', def: 'info' },
  { name: 'AIG_PROTOCOL_FALLBACKS', def: '' },
  { name: 'AIG_DASHBOARD_MODELS', def: '' },
  // Tier 1 429 cooldown ladder in milliseconds, comma separated ("15000,30000,60000,...").
  // Empty keeps the built-in ladder (15s, 30s, 1m, 2m, 5m, 15m, 30m, 1h).
  { name: 'AIG_RATE_LIMIT_STEPS_MS', def: '' },
  // Tier 2 subscription OAuth provider registry: JSON object keyed by
  // provider name -> { authorize_url, token_url, client_id, scope,
  // upstream_headers? }. Unset disables all subscription onboarding and
  // resolution (fail-closed). See docs/operations/configuration.md.
  { name: 'AIG_OAUTH_PROVIDERS', def: '' },
  // Access-key groups allowed to start Tier 2 subscription onboarding, comma
  // separated ("ULTRA" or "ULTRA,AGENT"). Unset disables onboarding
  // (fail-closed); already linked subscriptions keep working.
  { name: 'AIG_OAUTH_ADMIN_GROUPS', def: '' },
  // Access-key groups allowed to read /health and /metrics, comma separated ("AGENT" or
  // "AGENT,ULTRA"). Unset keeps the previous behavior: every valid key may read them.
  { name: 'AIG_DIAGNOSTICS_GROUPS', def: '' },
];

export const RUNTIME_BOOL_VARS: RuntimeBoolVar[] = [
  { name: 'AIG_SHOULD_EXPOSE_UPSTREAM', def: false },
  { name: 'AIG_HAS_STREAM_GUARD', def: false },
  { name: 'AIG_CAN_USE_HTTP', def: false },
  // Serve the public dashboard at / and the README status badge. false answers both with 404.
  { name: 'AIG_PUBLIC_DASHBOARD', def: true },
  // Tier 2 subscription proxying (auth:"oauth" nodes and /oauth/* onboarding). false loads no
  // subscription node and answers /oauth/* with 404. See SECURITY.md before enabling.
  { name: 'AIG_IS_SUBSCRIPTION_ENABLED', def: true },
  // Cache temperature=0 requests without the x-gateway-cache: true opt-in. Off by default.
  { name: 'AIG_EDGE_CACHE_AUTO', def: false },
];

// Every non-sensitive runtime variable name, for the deployment bridge.
export const RUNTIME_VAR_NAMES: string[] = [
  ...RUNTIME_TUNABLES.map((v) => v.name),
  ...RUNTIME_STRING_VARS.map((v) => v.name),
  ...RUNTIME_BOOL_VARS.map((v) => v.name),
];
