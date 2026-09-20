// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Single source of truth for every non-sensitive runtime variable the
// gateway recognizes. The deployment bridge (github-deployment-config.mjs)
// derives its allowlist from this registry; the timeout loader
// (timeouts.ts) derives its clamp limits from the int entries; docs and
// example configs reference the same names.
//
// Sensitive values (GATEWAY_KEY_<GROUP>, TIER*_CREDENTIALS_*, CLOUDFLARE_API_TOKEN)
// are NOT listed here — they are Secrets, never plain Worker variables.
//
// CLOUDFLARE_ACCOUNT_ID, USAGE_D1_ID and GATEWAY_PUBLIC_URL are
// deployment identifiers, not runtime tunables; the bridge handles them
// separately via REQUIRED_VARS / REQUIRED_SECRETS.

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
  { name: 'UPSTREAM_HEADER_TIMEOUT', type: 'int', min: 5_000, max: 600_000, def: 15_000 },
  { name: 'FIRST_EVENT_TIMEOUT', type: 'int', min: 5_000, max: 600_000, def: 30_000 },
  { name: 'STREAM_IDLE_TIMEOUT', type: 'int', min: 10_000, max: 600_000, def: 120_000 },
  { name: 'RATE_LIMIT_COOLDOWN', type: 'int', min: 1_000, max: 600_000, def: 30_000 },
  { name: 'AUTH_FAILURE_COOLDOWN', type: 'int', min: 60_000, max: 7 * 86_400_000, def: 3_600_000 },
  { name: 'MAX_BODY_BYTES', type: 'int', min: 1024, max: 100 * 1024 * 1024, def: 20 * 1024 * 1024 },
  { name: 'FAILOVER_BUDGET_MS', type: 'int', min: 1_000, max: 900_000, def: 60_000 },
  { name: 'HEDGE_DELAY_MS', type: 'int', min: 0, max: 600_000, def: 3_000 },
  { name: 'REQUEST_HEDGE_MAX', type: 'int', min: 0, max: 3, def: 1 },
  // Per-isolate, per-key RPM cap. Counts request-START moments in a
  // 60s sliding window. The cap is best-effort (single-isolate); for a
  // strict global cap across isolates, bind a Cloudflare Rate Limiting
  // worker binding (this is the existing model, see QUOTA_RATE_LIMITER).
  // 0 disables the cap entirely (default for backward compatibility).
  { name: 'GATEWAY_KEY_RPM', type: 'int', min: 0, max: 100_000, def: 0 },
] as const satisfies readonly RuntimeTunable[];

export type RuntimeTunableName = typeof RUNTIME_TUNABLES[number]['name'];

export const RUNTIME_STRING_VARS: RuntimeStringVar[] = [
  { name: 'ALLOWED_ORIGIN', def: '' },
  { name: 'USAGE_INCLUDE_MODE', def: 'auto' },
  { name: 'USAGE_EXCLUDE_PROVIDERS', def: '' },
  { name: 'ANTHROPIC_COUNT_MODE', def: 'approximate' },
  { name: 'LOG_LEVEL', def: 'info' },
  { name: 'PROTOCOL_FALLBACKS', def: '' },
  { name: 'DASHBOARD_MODELS', def: '' },
];

export const RUNTIME_BOOL_VARS: RuntimeBoolVar[] = [
  { name: 'SHOULD_EXPOSE_UPSTREAM', def: false },
  { name: 'HAS_STREAM_GUARD', def: false },
  { name: 'CAN_USE_HTTP', def: false },
];

// Every non-sensitive runtime variable name, for the deployment bridge.
export const RUNTIME_VAR_NAMES: string[] = [
  ...RUNTIME_TUNABLES.map((v) => v.name),
  ...RUNTIME_STRING_VARS.map((v) => v.name),
  ...RUNTIME_BOOL_VARS.map((v) => v.name),
];
