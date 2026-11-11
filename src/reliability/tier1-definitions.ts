// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Tier 1 constants and types. No isolate state is allocated here.

export const TIER1_EWMA_ALPHA = 0.25;
export const TIER1_OUTLIER_MULTIPLIER = 4;
export const TIER1_OUTLIER_CONSECUTIVE_THRESHOLD = 2;

export const TIER1_FAILURE_THRESHOLD = 3;
// A half-open model needs two consecutive successful observations before it is
// treated as healthy again: one success proves the node answers, two prove the
// answer was not a fluke.
export const TIER1_HALF_OPEN_SUCCESS_THRESHOLD = 2;
export const TIER1_COOLDOWN_DEFAULT_MS = 30_000;
export const TIER1_COOLDOWN_MAX_MS = 1_800_000;
export const TIER1_TIMEOUT_BASE_MS = 5_000;
export const TIER1_TIMEOUT_MAX_MS = 120_000;
export const TIER1_5XX_BASE_MS = 1_000;
export const TIER1_5XX_MAX_MS = 300_000;

// 429 cooldown duration is owned exclusively by adaptive-429.ts. This module
// stores the supplied deadline and controls the post-cooldown recovery probe;
// it must never invent a second rate-limit ladder.
export const TIER1_429_PROBE_GATE_MS = 15_000;

// A 429 is blamed on the model that received it. Only when a second distinct model
// on the same account is limited inside this window does the cooldown widen to the
// whole account (an account-wide quota looks exactly like that).
export const TIER1_429_ACCOUNT_ESCALATION_WINDOW_MS = 60_000;
export const TIER1_429_ACCOUNT_ESCALATION_MODELS = 2;
// A model id the upstream keeps answering "not found" for is not coming back in
// seconds: 5s, 20s, 80s, 5m, 20m, 30m (cleared by the first success).
export const TIER1_MODEL_MISSING_LADDER_MS = Object.freeze([5_000, 20_000, 80_000, 300_000, 1_200_000, 1_800_000] as const);
// Sibling keys of one provider usually share a quota window. When one recovers,
// siblings still cooling down for at least this long are let back in early.
export const TIER1_SIBLING_WAKE_MIN_REMAINING_MS = 60_000;
// How long a "this request was too large" observation keeps large requests away.
// After it lapses one request probes again, so a raised provider limit is noticed.
export const TIER1_OVERSIZE_MEMORY_MS = 10 * 60_000;
// A 403 refuses one request (policy, moderation, region, model permission), not the
// key, so it is blamed on the model that got it. The first refusal costs nothing;
// each refusal after the previous cooldown lapsed climbs 60s, 10m, then the auth
// cooldown. A success clears the ladder.
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
  // Live requests on this logical model. The half-open single-probe gate counts
  // these, so traffic on the key's other models never starves a recovery probe.
  inFlight: number;
  disabled: boolean;
  cooldownUntil: number;
  cooldownReason: string | null;
  failureState: Tier1FailureState;
  consecutiveFailures: number;
  consecutiveRateLimits: number;
  consecutiveOutliers: number;
  // 403 refusals in a row on this model; drives TIER1_FORBIDDEN_LADDER_MS.
  consecutiveForbidden: number;
  halfOpenSuccesses: number;
  ttftEwma: number | null;
  sampleCount: number;
  lastObservedAt: number;
  scopeAmbiguous429: boolean;
  rateLimitRecoveryPending: boolean;
  rateLimitRecoveryUntil: number;
  // The current rate-limit cooldown is a long-lived allowance (hourly/daily
  // window). Such a window belongs to this one credential, so it is not woken
  // early when a sibling key recovers.
  cooldownIsQuota: boolean;
};

export type Tier1QuotaState = 'normal' | 'near_limit' | 'exhausted_until';

export type Tier1AccountRuntime = {
  accountId: string;
  // Provider this account belongs to, learned when it is first claimed. Used to
  // wake sibling keys of the same provider when one of them recovers.
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
  // See Tier1ModelRuntime.cooldownIsQuota.
  accountCooldownIsQuota: boolean;
  // Logical models that recently took a 429 on this account (model -> last time).
  // Two distinct models limited inside the window is the evidence that the limit
  // belongs to the whole account, not to one upstream model.
  recentRateLimitedModels: Map<string, number>;
  // Smallest request (in body characters) each logical model recently refused as
  // too large, with the time the memory lapses. Requests at least that large skip
  // this account instead of paying a guaranteed 413 round trip.
  oversizeCeilings: Map<string, { chars: number; until: number }>;
  // How many times in a row an upstream model id answered "not found". Drives the
  // model_missing ladder; cleared when that upstream model serves a request.
  upstreamModelMisses: Map<string, number>;
  quotaState: Tier1QuotaState;
  quotaResetAt: number;
  // Provider-reported quota, isolate-local. `null` = unknown: the gateway never
  // fabricates a hard limit and keeps its reactive adaptive-429 + cooldown
  // behavior. When a provider reports remaining requests/tokens, these drive a
  // reservation counter so concurrent admission cannot all see the same tail of
  // a window (the "20 concurrent requests see remaining=10" guard).
  quotaRemainingRequests: number | null;
  quotaRemainingTokens: number | null;
  quotaSource: string | null;
  // Per-account outstanding reservations not yet settled with actual usage.
  // Restored on release-before-settle (abort/pre-execution failure); confirmed
  // consumed on settle. Synchronous claim->makeToken keeps this race-free in
  // the single-threaded isolate.
  quotaReservedInFlight: number;
  // model_missing is about the provider-facing model id, not the gateway's
  // logical alias. Keep that short cooldown separate from logical-model
  // performance/circuit state so remapping Code-Max does not inherit stale 404s.
  upstreamModelCooldowns: Map<string, number>;
  models: Map<string, Tier1ModelRuntime>;
};

export type Tier1ReleaseToken = { accountId: string; modelId: string | null; released: boolean; settled: boolean; quotaReserved: number };

/** Failure-kind classification input consumed from the reliability layer.
 * `kind` is an open string: stream-layer kinds (e.g. 'stream_interrupted')
 * also flow through here, carrying the stream-layer `streamReason`. */
export type Tier1FailureInput =
  | {
      kind?: string;
      cooldownMs?: number;
      retryAfterMs?: number;
      rateLimitScope?: string;
      /** 'quota' for a long-lived allowance; any other value is a short window. */
      rateLimitClass?: string;
      /** A 403: the request was refused, not the credential. */
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
  /** True when a rate-limit cooldown reflects a long-lived allowance. */
  isQuota?: boolean;
};

/**
 * A cooldown another isolate should honour: evidence that outlives this isolate
 * and is never cleared early. A credential rejection (401) or long-lived quota
 * on the account, or an escalated 403 refusal on one model. Short rate-limit
 * windows are not shared: a recovering sibling key may wake them early.
 */
export type Tier1SharedCooldown = { node: string; model?: string; until: number; reason: string; quota?: boolean };

export const TIER1_FAILURE_STATES = FAILURE_STATE;
