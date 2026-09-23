// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Single source of truth for every non-sensitive runtime variable the
// gateway recognizes. The deployment bridge (github-deployment-config.mjs)
// derives its allowlist from this registry; the timeout loader
// (timeouts.ts) derives its clamp limits from the int entries; docs and
// example configs reference the same names.
//
// Sensitive values (AIG_ACCESS_KEY_<GROUP>, TIER*_CREDENTIALS_*, CLOUDFLARE_API_TOKEN)
// are NOT listed here — they are Secrets, never plain Worker variables.
//
// CLOUDFLARE_ACCOUNT_ID and AIG_USAGE_D1_ID are deployment identifiers.
// AIG_PUBLIC_URL is deployment-owned runtime metadata used by the dashboard;
// the deployment bridge passes it through separately from runtime tunables.

export interface RuntimeTunable {
  name: string,
  type: 'int',
  min: number,
  max: number,
  def: number,
}

export interface RuntimeStringVar {
  name: string,
  def: string,
}

export interface RuntimeBoolVar {
  name: string,
  def: boolean,
}

export const RUNTIME_TUNABLES = [
  { name: 'AIG_UPSTREAM_HEADER_TIMEOUT_MS', type: 'int', min: 5_000, max: 600_000, def: 30_000 },
  { name: 'AIG_FIRST_EVENT_TIMEOUT_MS', type: 'int', min: 5_000, max: 600_000, def: 60_000 },
  { name: 'AIG_STREAM_IDLE_TIMEOUT_MS', type: 'int', min: 10_000, max: 600_000, def: 120_000 },
  { name: 'AIG_RATE_LIMIT_COOLDOWN_MS', type: 'int', min: 1_000, max: 600_000, def: 30_000 },
  { name: 'AIG_AUTH_FAILURE_COOLDOWN_MS', type: 'int', min: 60_000, max: 7 * 86_400_000, def: 3_600_000 },
  { name: 'AIG_REQUEST_BODY_MAX_BYTES', type: 'int', min: 1024, max: 100 * 1024 * 1024, def: 20 * 1024 * 1024 },
  { name: 'AIG_FAILOVER_BUDGET_MS', type: 'int', min: 1_000, max: 900_000, def: 120_000 },
  { name: 'AIG_HEDGE_DELAY_MS', type: 'int', min: 0, max: 600_000, def: 3_000 },
  { name: 'AIG_REQUEST_HEDGE_MAX', type: 'int', min: 0, max: 3, def: 1 },
  // Per-isolate, per-key RPM cap. Counts request-START moments in a
  // 60s sliding window. The cap is best-effort (single-isolate); for a
  // strict global cap across isolates, bind a Cloudflare Rate Limiting
  // worker binding (this is the existing model, see QUOTA_RATE_LIMITER).
  // 0 disables the cap entirely (default for backward compatibility).
  { name: 'AIG_ACCESS_KEY_RPM', type: 'int', min: 0, max: 100_000, def: 0 },
] as const satisfies readonly RuntimeTunable[];

export type RuntimeTunableName = typeof RUNTIME_TUNABLES[number]['name'];

export const RUNTIME_STRING_VARS: RuntimeStringVar[] = [
  { name: 'AIG_CORS_ORIGIN', def: '' },
  { name: 'AIG_USAGE_INCLUDE_MODE', def: 'auto' },
  { name: 'AIG_USAGE_EXCLUDE_PROVIDERS', def: '' },
  { name: 'AIG_ANTHROPIC_COUNT_MODE', def: 'approximate' },
  { name: 'AIG_LOG_LEVEL', def: 'info' },
  { name: 'AIG_PROTOCOL_FALLBACKS', def: '' },
  { name: 'AIG_DASHBOARD_MODELS', def: '' },
];

export const RUNTIME_BOOL_VARS: RuntimeBoolVar[] = [
  { name: 'AIG_SHOULD_EXPOSE_UPSTREAM', def: false },
  { name: 'AIG_HAS_STREAM_GUARD', def: false },
  { name: 'AIG_CAN_USE_HTTP', def: false },
];

// Every non-sensitive runtime variable name, for the deployment bridge.
export const RUNTIME_VAR_NAMES: string[] = [
  ...RUNTIME_TUNABLES.map((v) => v.name),
  ...RUNTIME_STRING_VARS.map((v) => v.name),
  ...RUNTIME_BOOL_VARS.map((v) => v.name),
];
