// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

export const TIER1_EWMA_ALPHA = 0.25;
export const TIER1_OUTLIER_MULTIPLIER = 4;
export const TIER1_OUTLIER_CONSECUTIVE_THRESHOLD = 2;

export const TIER1_FAILURE_THRESHOLD = 3;
export const TIER1_FAST_COOLDOWN_MS = 15_000;
export const TIER1_FAILURE_STREAK_WINDOW_MS = 90_000;
export const TIER1_CIRCUIT_COOLDOWN_FLOOR_MS = 30_000;
export const TIER1_HALF_OPEN_SUCCESS_THRESHOLD = 2;
export const TIER1_COOLDOWN_DEFAULT_MS = 30_000;
export const TIER1_COOLDOWN_MAX_MS = 1_800_000;
export const TIER1_TIMEOUT_BASE_MS = 5_000;
export const TIER1_TIMEOUT_MAX_MS = 120_000;
export const TIER1_5XX_BASE_MS = 1_000;
export const TIER1_5XX_MAX_MS = 300_000;

export const TIER1_429_PROBE_GATE_MS = 15_000;

export const TIER1_429_ACCOUNT_ESCALATION_WINDOW_MS = 60_000;
export const TIER1_429_ACCOUNT_ESCALATION_MODELS = 2;
export const TIER1_MODEL_MISSING_LADDER_MS = Object.freeze([5_000, 20_000, 80_000, 300_000, 1_200_000, 1_800_000] as const);
export const TIER1_SIBLING_WAKE_MIN_REMAINING_MS = 60_000;
export const TIER1_OVERSIZE_MEMORY_MS = 10 * 60_000;
export const TIER1_FORBIDDEN_LADDER_MS = Object.freeze([0, 60_000, 600_000] as const);

export const FAILURE_STATE = Object.freeze({
  NORMAL: 'normal',
  COOLDOWN: 'cooldown',
  HALF_OPEN: 'half_open',
  DISABLED: 'disabled',
} as const);

export type Tier1FailureState = (typeof FAILURE_STATE)[keyof typeof FAILURE_STATE];

export type Tier1ModelRuntime = {
  supported: boolean;
  inFlight: number;
  disabled: boolean;
  cooldownUntil: number;
  cooldownReason: string | null;
  failureState: Tier1FailureState;
  consecutiveFailures: number;
  lastCountedFailureAt: number;
  consecutiveRateLimits: number;
  consecutiveOutliers: number;
  consecutiveForbidden: number;
  halfOpenSuccesses: number;
  ttftEwma: number | null;
  sampleCount: number;
  lastObservedAt: number;
  scopeAmbiguous429: boolean;
  rateLimitRecoveryPending: boolean;
  rateLimitRecoveryUntil: number;
  cooldownIsQuota: boolean;
};

export type Tier1QuotaState = 'normal' | 'near_limit' | 'exhausted_until';

export type Tier1AccountRuntime = {
  accountId: string;
  provider: string | null;
  inFlight: number;
  accountDisabled: boolean;
  accountCooldownUntil: number;
  accountCooldownReason: string | null;
  consecutiveAccountFailures: number;
  consecutiveRateLimits: number;
  scopeAmbiguous429: boolean;
  rateLimitRecoveryPending: boolean;
  rateLimitRecoveryUntil: number;
  accountCooldownIsQuota: boolean;
  recentRateLimitedModels: Map<string, number>;
  oversizeCeilings: Map<string, { chars: number; until: number }>;
  upstreamModelMisses: Map<string, number>;
  quotaState: Tier1QuotaState;
  quotaResetAt: number;
  quotaRemainingRequests: number | null;
  quotaRemainingTokens: number | null;
  quotaSource: string | null;
  quotaReservedInFlight: number;
  upstreamModelCooldowns: Map<string, number>;
  models: Map<string, Tier1ModelRuntime>;
};

export type Tier1ReleaseToken = { accountId: string; modelId: string | null; released: boolean; settled: boolean; quotaReserved: number };

export type Tier1FailureInput =
  | {
      kind?: string;
      cooldownMs?: number;
      retryAfterMs?: number;
      rateLimitScope?: string;
      rateLimitClass?: string;
      forbidden?: boolean;
      streamReason?: unknown;
    }
  | null
  | undefined;

export type Tier1Outcome = {
  scope: 'account' | 'model' | 'upstream_model' | 'none';
  action: 'disable' | 'cooldown' | 'neutral';
  reason: string;
  counted?: boolean;
  cooldownMs?: number;
  backoff?: 'rate_limit' | 'timeout' | 'server' | 'forbidden' | 'default';
  scopeAmbiguous?: boolean;
  isQuota?: boolean;
};

export type Tier1SharedCooldown = { node: string; model?: string; until: number; reason: string; quota?: boolean };

export const TIER1_FAILURE_STATES = FAILURE_STATE;
