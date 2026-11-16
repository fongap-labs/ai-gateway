// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

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
  { name: 'AIG_REQUEST_BODY_MAX_BYTES', type: 'int', min: 1024, max: 32 * 1024 * 1024, def: 20 * 1024 * 1024 },
  { name: 'AIG_FAILOVER_BUDGET_MS', type: 'int', min: 1_000, max: 900_000, def: 60_000 },
  { name: 'AIG_HEDGE_DELAY_MS', type: 'int', min: 0, max: 600_000, def: 3_000 },
  { name: 'AIG_REQUEST_HEDGE_MAX', type: 'int', min: 0, max: 3, def: 1 },
  { name: 'AIG_ISOLATE_MAX_IN_FLIGHT', type: 'int', min: 0, max: 512, def: 0 },
  { name: 'AIG_CHUNKED_BODY_MAX_BYTES', type: 'int', min: 16_384, max: 32 * 1024 * 1024, def: 524_288 },
  { name: 'AIG_STREAM_MAX_ATTEMPTS', type: 'int', min: 1, max: 8, def: 2 },
  { name: 'AIG_NONSTREAM_MAX_ATTEMPTS', type: 'int', min: 1, max: 8, def: 3 },
  { name: 'AIG_ACCESS_KEY_RPM', type: 'int', min: 0, max: 100_000, def: 0 },
  { name: 'AIG_AUTH_ATTEMPT_RPM', type: 'int', min: 0, max: 100_000, def: 60 },
  { name: 'AIG_EDGE_CACHE_TTL_SEC', type: 'int', min: 0, max: 7 * 86_400, def: 14_400 },
  { name: 'AIG_TOKEN_D1_SAMPLE_PCT', type: 'int', min: 0, max: 100, def: 100 },
  { name: 'AIG_AFFINITY_WRITE', type: 'int', min: 0, max: 1, def: 1 },
  { name: 'AIG_AFFINITY_READ_TIMEOUT_MS', type: 'int', min: 1, max: 1_000, def: 50 },
  { name: 'AIG_TIER1_PROBE_TIMEOUT_MS', type: 'int', min: 5_000, max: 30_000, def: 10_000 },
  { name: 'AIG_STREAM_GUARD_PREFIX_BYTES', type: 'int', min: 16_384, max: 2 * 1024 * 1024, def: 65_536 },
  { name: 'AIG_CONVERSION_MAX_EVENTS', type: 'int', min: 25, max: 100_000, def: 400 },
  { name: 'AIG_CONVERSION_MAX_BYTES', type: 'int', min: 4_096, max: 4 * 1024 * 1024, def: 131_072 },
  { name: 'AIG_CONVERSION_MAX_TOOL_EVENTS', type: 'int', min: 2, max: 100_000, def: 200 },
  { name: 'AIG_CONVERSION_MAX_TOOL_ARG_BYTES', type: 'int', min: 1_024, max: 1024 * 1024, def: 65_536 },
  { name: 'AIG_CONVERSION_NONSTREAM_MAX_BYTES', type: 'int', min: 4_096, max: 4 * 1024 * 1024, def: 131_072 },
  { name: 'AIG_CONVERSION_MAX_OUTPUT_TOKENS', type: 'int', min: 0, max: 10_000_000, def: 0 },
] as const satisfies readonly RuntimeTunable[];

export type RuntimeTunableName = (typeof RUNTIME_TUNABLES)[number]['name'];

export const DIAGNOSTICS_GROUPS_DEFAULT = 'MAX,ULTRA';

export const RUNTIME_STRING_VARS: RuntimeStringVar[] = [
  { name: 'AIG_CORS_ORIGIN', def: '' },
  { name: 'AIG_USAGE_INCLUDE_MODE', def: 'auto' },
  { name: 'AIG_USAGE_EXCLUDE_PROVIDERS', def: '' },
  { name: 'AIG_ANTHROPIC_COUNT_MODE', def: 'approximate' },
  { name: 'AIG_LOG_LEVEL', def: 'info' },
  { name: 'AIG_PROTOCOL_FALLBACKS', def: '' },
  { name: 'AIG_DASHBOARD_MODELS', def: '' },
  { name: 'AIG_RATE_LIMIT_STEPS_MS', def: '' },
  { name: 'AIG_RATE_LIMIT_WINDOW_STEPS_MS', def: '' },
  { name: 'AIG_RATE_LIMIT_QUOTA_STEPS_MS', def: '' },
  { name: 'AIG_CONVERSION_BUDGET_MODE', def: 'error' },
  { name: 'AIG_DIAGNOSTICS_GROUPS', def: DIAGNOSTICS_GROUPS_DEFAULT },
];

export const RUNTIME_BOOL_VARS: RuntimeBoolVar[] = [
  { name: 'AIG_SHOULD_EXPOSE_UPSTREAM', def: false },
  { name: 'AIG_HAS_STREAM_GUARD', def: false },
  { name: 'AIG_CAN_USE_HTTP', def: false },
  { name: 'AIG_PUBLIC_DASHBOARD', def: true },
  { name: 'AIG_TIER1_PROBE_V2', def: false },
  { name: 'AIG_STREAM_PASSTHROUGH', def: false },
  { name: 'AIG_CONVERSION_BUDGET', def: false },
  { name: 'AIG_CONVERSION_PREFER_NONSTREAM', def: false },
  { name: 'AIG_REQUEST_ADMISSION', def: false },
  { name: 'AIG_COST_GUARDS', def: false },
  { name: 'AIG_HOT_PATH_GUARDS', def: false },
];

export const RUNTIME_VAR_NAMES: string[] = [
  ...RUNTIME_TUNABLES.map((v) => v.name),
  ...RUNTIME_STRING_VARS.map((v) => v.name),
  ...RUNTIME_BOOL_VARS.map((v) => v.name),
];
