// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Isolate-local adaptive state for Tier 1 only. Performance is learned from
// real requests at (account, model) scope. Tier 2/3 continue to use
// node-state.ts and never read this module.

import { servesModel } from '../config/registry.ts';
import { RUNTIME_TUNABLES } from '../config/runtime-vars.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { RoutableRequest } from '../types/scheduler.ts';
import { jitterCooldownMs } from './cooldown-jitter.ts';

export const TIER1_EWMA_ALPHA = 0.25;
export const TIER1_OUTLIER_MULTIPLIER = 4;
export const TIER1_OUTLIER_CONSECUTIVE_THRESHOLD = 2;

export const TIER1_FAILURE_THRESHOLD = 3;
export const TIER1_HALF_OPEN_SUCCESS_THRESHOLD = 2;
export const TIER1_COOLDOWN_DEFAULT_MS = 30_000;
export const TIER1_COOLDOWN_MAX_MS = 1_800_000;
export const TIER1_TIMEOUT_BASE_MS = 5_000;
export const TIER1_TIMEOUT_MAX_MS = 120_000;
export const TIER1_5XX_BASE_MS = 1_000;
export const TIER1_5XX_MAX_MS = 300_000;
// Auth (401/403) cooldown is account-scoped and comes from the shared upstream
// classifier. If a direct internal caller omits the duration, fall back to the
// canonical runtime-variable default rather than maintaining a second literal.
const TIER1_AUTH_DEFAULT_COOLDOWN_MS = RUNTIME_TUNABLES.find(
  (entry) => entry.name === 'AIG_AUTH_FAILURE_COOLDOWN_MS',
)?.def ?? 0;
// 429 cooldown duration is owned exclusively by adaptive-429.ts. This module
// stores the supplied deadline and controls the post-cooldown recovery probe;
// it must never invent a second rate-limit ladder.
export const TIER1_429_PROBE_GATE_MS = 5_000;

const FAILURE_STATE = Object.freeze({
  NORMAL: 'normal',
  COOLDOWN: 'cooldown',
  HALF_OPEN: 'half_open',
  DISABLED: 'disabled',
} as const);

export type Tier1FailureState = typeof FAILURE_STATE[keyof typeof FAILURE_STATE];

export type Tier1ModelRuntime = {
  supported: boolean,
  disabled: boolean,
  cooldownUntil: number,
  cooldownReason: string | null,
  failureState: Tier1FailureState,
  consecutiveFailures: number,
  consecutiveRateLimits: number,
  consecutiveOutliers: number,
  halfOpenSuccesses: number,
  ttftEwma: number | null,
  sampleCount: number,
  lastObservedAt: number,
  scopeAmbiguous429: boolean,
  rateLimitRecoveryPending: boolean,
  rateLimitRecoveryUntil: number,
};

export type Tier1QuotaState = 'normal' | 'near_limit' | 'exhausted_until';

export type Tier1AccountRuntime = {
  accountId: string,
  inFlight: number,
  accountDisabled: boolean,
  accountCooldownUntil: number,
  accountCooldownReason: string | null,
  consecutiveAccountFailures: number,
  consecutiveRateLimits: number,
  scopeAmbiguous429: boolean,
  rateLimitRecoveryPending: boolean,
  rateLimitRecoveryUntil: number,
  quotaState: Tier1QuotaState,
  quotaResetAt: number,
  // Provider-reported quota, isolate-local. `null` = unknown: the gateway never
  // fabricates a hard limit and keeps its reactive adaptive-429 + cooldown
  // behavior. When a provider reports remaining requests/tokens, these drive a
  // reservation counter so concurrent admission cannot all see the same tail of
  // a window (the "20 concurrent requests see remaining=10" guard).
  quotaRemainingRequests: number | null,
  quotaRemainingTokens: number | null,
  quotaSource: string | null,
  // Per-account outstanding reservations not yet settled with actual usage.
  // Restored on release-before-settle (abort/pre-execution failure); confirmed
  // consumed on settle. Synchronous claim->makeToken keeps this race-free in
  // the single-threaded isolate.
  quotaReservedInFlight: number,
  // model_missing is about the provider-facing model id, not the gateway's
  // logical alias. Keep that short cooldown separate from logical-model
  // performance/circuit state so remapping Code-Max does not inherit stale 404s.
  upstreamModelCooldowns: Map<string, number>,
  models: Map<string, Tier1ModelRuntime>,
};

export type Tier1ReleaseToken = { accountId: string, released: boolean, settled: boolean, quotaReserved: number };

/** Failure-kind classification input consumed from the reliability layer.
 * `kind` is an open string: stream-layer kinds (e.g. 'stream_interrupted')
 * also flow through here, carrying the stream-layer `streamReason`. */
export type Tier1FailureInput = {
  kind?: string,
  cooldownMs?: number,
  retryAfterMs?: number,
  rateLimitScope?: string,
  streamReason?: unknown,
} | null | undefined;

export type Tier1Outcome = {
  scope: 'account' | 'model' | 'upstream_model' | 'none',
  action: 'disable' | 'cooldown' | 'neutral',
  reason: string,
  counted?: boolean,
  cooldownMs?: number,
  backoff?: 'rate_limit' | 'timeout' | 'server' | 'default',
  scopeAmbiguous?: boolean,
};

const accounts = new Map<string, Tier1AccountRuntime>();

function newModelRuntime(): Tier1ModelRuntime {
  return {
    supported: true,
    disabled: false,
    cooldownUntil: 0,
    cooldownReason: null,
    failureState: FAILURE_STATE.NORMAL,
    consecutiveFailures: 0,
    consecutiveRateLimits: 0,
    consecutiveOutliers: 0,
    halfOpenSuccesses: 0,
    ttftEwma: null,
    sampleCount: 0,
    lastObservedAt: 0,
    scopeAmbiguous429: false,
    rateLimitRecoveryPending: false,
    rateLimitRecoveryUntil: 0,
  };
}

function newAccountRuntime(accountId: string): Tier1AccountRuntime {
  return {
    accountId,
    inFlight: 0,
    accountDisabled: false,
    accountCooldownUntil: 0,
    accountCooldownReason: null,
    consecutiveAccountFailures: 0,
    consecutiveRateLimits: 0,
    scopeAmbiguous429: false,
    rateLimitRecoveryPending: false,
    rateLimitRecoveryUntil: 0,
    quotaState: 'normal',
    quotaResetAt: 0,
    quotaRemainingRequests: null,
    quotaRemainingTokens: null,
    quotaSource: null,
    quotaReservedInFlight: 0,
    upstreamModelCooldowns: new Map(),
    models: new Map(),
  };
}

export function getTier1Account(accountId: string): Tier1AccountRuntime {
  let account = accounts.get(accountId);
  if (!account) {
    account = newAccountRuntime(accountId);
    accounts.set(accountId, account);
  }
  return account;
}

export function getTier1Model(accountId: string, modelId: string): Tier1ModelRuntime {
  const account = getTier1Account(accountId);
  let model = account.models.get(modelId);
  if (!model) {
    model = newModelRuntime();
    account.models.set(modelId, model);
  }
  return model;
}

export function getTier1ModelPerf(accountId: string, modelId: string): Tier1ModelRuntime | null {
  return accounts.get(accountId)?.models.get(modelId) ?? null;
}

export function tier1AccountInFlight(accountId: string): number {
  return accounts.get(accountId)?.inFlight ?? 0;
}

export function tier1QuotaState(accountId: string, now: number = Date.now()): Tier1QuotaState {
  const account = accounts.get(accountId);
  if (!account) return 'normal';
  if (account.quotaState === 'exhausted_until' && account.quotaResetAt <= now) return 'normal';
  return account.quotaState;
}

function tier1UpstreamModelOf(node: RuntimeNode, logicalModel: string): string {
  return node.models[logicalModel] || logicalModel;
}

function upstreamModelCooldownRemainingMs(account: Tier1AccountRuntime, node: RuntimeNode, logicalModel: string, now: number): number {
  const until = account.upstreamModelCooldowns.get(tier1UpstreamModelOf(node, logicalModel)) ?? 0;
  return until > now ? until - now : 0;
}

function recoveryGateMs(): number {
  return TIER1_429_PROBE_GATE_MS;
}

// A provider-reported window that has rolled over is stale: the old remaining
// tail is meaningless and must not keep the account blocked or admitted at a
// fabricated count. Expiry returns the account to unknown quota until the next
// report re-establishes the window; recovery then follows the normal reactive
// path (429 -> cooldown -> probe -> restore).
function normalizeQuotaWindow(account: Tier1AccountRuntime, now: number): void {
  if (account.quotaResetAt > 0 && account.quotaResetAt <= now) {
    account.quotaResetAt = 0;
    account.quotaState = 'normal';
    account.quotaRemainingRequests = null;
    account.quotaRemainingTokens = null;
  }
}

export function claimTier1Slot(node: RuntimeNode, now: number = Date.now(), modelId: string | null = null, maxInFlight: number | null = null): boolean {
  const account = getTier1Account(node.id);
  normalizeQuotaWindow(account, now);
  if (account.accountDisabled || account.accountCooldownUntil > now || account.rateLimitRecoveryUntil > now) return false;
  const model = modelId ? account.models.get(modelId) : null;
  if (modelId && upstreamModelCooldownRemainingMs(account, node, modelId, now) > 0) return false;
  if ((model?.rateLimitRecoveryUntil ?? 0) > now) return false;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return false;
  if (maxInFlight !== null && account.inFlight >= maxInFlight) return false;
  // Quota admission. Only applies when the provider has reported an absolute
  // remaining-request count; unknown quota (null) is a no-op pass-through so the
  // gateway never fabricates a hard limit and keeps its reactive 429 path. The
  // reservation is restored on release-before-settle and confirmed consumed on
  // settle, so concurrent admission cannot all pass against the tail of a window.
  if (account.quotaRemainingRequests !== null && account.quotaRemainingRequests <= 0) return false;
  account.inFlight++;
  if (account.quotaRemainingRequests !== null) {
    account.quotaRemainingRequests--;
    account.quotaReservedInFlight++;
  }
  if (account.rateLimitRecoveryPending) {
    account.rateLimitRecoveryPending = false;
    account.rateLimitRecoveryUntil = now + recoveryGateMs();
  }
  if (model?.rateLimitRecoveryPending) {
    model.rateLimitRecoveryPending = false;
    model.rateLimitRecoveryUntil = now + recoveryGateMs();
  }
  return true;
}

export function makeTier1ReleaseToken(accountId: string): Tier1ReleaseToken {
  const account = accounts.get(accountId);
  // Stamp the reservation this claim acquired so release/settle can restore or
  // confirm it per-token. Synchronous claim->makeToken keeps this race-free in
  // the single-threaded isolate; a token always carries its own reservation.
  const reserved = account && account.quotaRemainingRequests !== null ? 1 : 0;
  return { accountId, released: false, settled: false, quotaReserved: reserved };
}

export function releaseTier1Slot(accountId: string, token: Tier1ReleaseToken | null | undefined): boolean {
  if (!token || token.accountId !== accountId || token.released) return false;
  token.released = true;
  const account = accounts.get(accountId);
  if (account) {
    account.inFlight = Math.max(0, account.inFlight - 1);
    // Restore the unconfirmed request reservation unless the lease was settled
    // with actual usage. Abort / pre-execution failure / hedge loss before
    // settlement give the reservation back; a settled lease has already
    // confirmed consumption. Over-restore (a missed settle) only makes a node
    // look healthier and falls back to the reactive 429 path — never a leak.
    if (!token.settled && token.quotaReserved > 0 && account.quotaRemainingRequests !== null && account.quotaReservedInFlight > 0) {
      account.quotaRemainingRequests++;
      account.quotaReservedInFlight--;
    }
  }
  return true;
}

/** Confirm actual quota consumption for a lease. Idempotent. The request
 *  reservation is consumed (not restored on release); token-usage is subtracted
 *  from the remaining-token window when the provider reports one. */
export function settleTier1Quota(accountId: string, token: Tier1ReleaseToken | null | undefined, consumedTokens: number = 0): void {
  if (!token || token.accountId !== accountId || token.settled) return;
  token.settled = true;
  const account = accounts.get(accountId);
  if (!account) return;
  if (token.quotaReserved > 0 && account.quotaReservedInFlight > 0) {
    account.quotaReservedInFlight--;
  }
  if (account.quotaRemainingTokens !== null && Number.isFinite(consumedTokens) && consumedTokens > 0) {
    account.quotaRemainingTokens = Math.max(0, account.quotaRemainingTokens - Math.trunc(consumedTokens));
  }
}

function modelBlocked(model: Tier1ModelRuntime | null | undefined, now: number): boolean {
  return model?.disabled || (model?.cooldownUntil ?? 0) > now;
}

export function isTier1Eligible(node: RuntimeNode, req: RoutableRequest, now: number = Date.now(), knownModels?: ReadonlySet<string> | null, maxInFlight?: number | null): boolean {
  if (!node || node.tier !== 'tier-1') return false;
  if (node.protocol !== req.protocol) return false;
  if (!Array.isArray(node.surfaces) || !node.surfaces.includes(req.surface)) return false;
  if (!servesModel(node, req.model, knownModels)) return false;
  const account = accounts.get(node.id);
  if (!account) return true;
  normalizeQuotaWindow(account, now);
  if (account.accountDisabled || account.accountCooldownUntil > now || account.rateLimitRecoveryUntil > now) return false;
  if (upstreamModelCooldownRemainingMs(account, node, req.model, now) > 0) return false;
  const model = account.models.get(req.model);
  if (modelBlocked(model, now) || (model?.rateLimitRecoveryUntil ?? 0) > now) return false;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return false;
  if (account.quotaState === 'exhausted_until' && account.quotaResetAt > now) return false;
  // A provider-reported window tail at zero also gates eligibility: the pool
  // must not even sample a node whose known quota is spent. Unknown quota
  // (null) keeps the previous behavior untouched.
  if (account.quotaRemainingRequests !== null && account.quotaRemainingRequests <= 0) return false;
  if (maxInFlight !== null && maxInFlight !== undefined && maxInFlight > 0 && account.inFlight >= maxInFlight) return false;
  return true;
}

export function maybeTransitionToHalfOpen(accountId: string, modelId: string, now: number = Date.now()): void {
  const model = accounts.get(accountId)?.models.get(modelId);
  if (model?.failureState === FAILURE_STATE.COOLDOWN && model.cooldownUntil <= now) {
    model.failureState = FAILURE_STATE.HALF_OPEN;
    model.halfOpenSuccesses = 0;
  }
}

export function tier1CountDispatchableNodes(nodes: ReadonlyArray<RuntimeNode>, req: RoutableRequest, attempted: Set<string>, now: number = Date.now(), knownModels?: ReadonlySet<string> | null, maxInFlight?: number | null): number {
  let count = 0;
  for (const node of nodes ?? []) {
    if (attempted.has(node.id)) continue;
    maybeTransitionToHalfOpen(node.id, req.model, now);
    if (isTier1Eligible(node, req, now, knownModels, maxInFlight)) count++;
  }
  return count;
}

export function tier1HasDispatchableNode(nodes: ReadonlyArray<RuntimeNode>, req: RoutableRequest, attempted: Set<string>, now: number = Date.now(), knownModels?: ReadonlySet<string> | null, maxInFlight?: number | null): boolean {
  return tier1CountDispatchableNodes(nodes, req, attempted, now, knownModels, maxInFlight) > 0;
}

export function recordTier1Ttft(accountId: string, modelId: string, observedMs: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(observedMs) || observedMs < 0) return false;
  const model = getTier1Model(accountId, modelId);
  if (model.ttftEwma == null || model.sampleCount === 0) {
    model.ttftEwma = observedMs;
    model.consecutiveOutliers = 0;
  } else {
    const threshold = model.ttftEwma * TIER1_OUTLIER_MULTIPLIER;
    let effectiveSample = observedMs;
    if (observedMs > threshold) {
      model.consecutiveOutliers++;
      if (model.consecutiveOutliers < TIER1_OUTLIER_CONSECUTIVE_THRESHOLD) effectiveSample = threshold;
    } else {
      model.consecutiveOutliers = 0;
    }
    model.ttftEwma = TIER1_EWMA_ALPHA * effectiveSample
      + (1 - TIER1_EWMA_ALPHA) * model.ttftEwma;
  }
  model.sampleCount++;
  model.lastObservedAt = now;
  return true;
}

export function classifyTier1Failure(classification: Tier1FailureInput, opts: { retryAfterMs?: number } = {}): Tier1Outcome {
  const { retryAfterMs } = opts;
  const kind = classification?.kind;
  if (kind === 'auth') {
    return {
      scope: 'account', action: 'disable', reason: kind,
      cooldownMs: Math.max(0, classification?.cooldownMs ?? TIER1_AUTH_DEFAULT_COOLDOWN_MS),
    };
  }
  if (kind === 'model_missing') {
    return {
      scope: 'upstream_model', action: 'cooldown', counted: false,
      cooldownMs: classification?.cooldownMs || 5_000, reason: kind,
    };
  }
  if (kind === 'endpoint_not_found') {
    return { scope: 'account', action: 'cooldown', counted: false, cooldownMs: classification?.cooldownMs || 5_000, reason: kind };
  }
  if (kind === 'rate_limit') {
    const explicit = retryAfterMs ?? classification?.retryAfterMs ?? 0;
    return {
      scope: classification?.rateLimitScope === 'model' ? 'model' : 'account',
      action: 'cooldown', counted: false, cooldownMs: explicit,
      backoff: 'rate_limit', reason: kind,
      scopeAmbiguous: !classification?.rateLimitScope,
    };
  }
  if (kind === 'client' || kind === 'client_abort') {
    return { scope: 'none', action: 'neutral', counted: false, cooldownMs: 0, reason: kind };
  }
  if (kind === 'headers_timeout' || kind === 'first_event_timeout' || kind === 'network' || kind === 'stream_interrupted') {
    return { scope: 'model', action: 'cooldown', counted: true, cooldownMs: 0, backoff: 'timeout', reason: kind };
  }
  if (kind === 'server') {
    return { scope: 'model', action: 'cooldown', counted: true, cooldownMs: 0, backoff: 'server', reason: kind };
  }
  return { scope: 'model', action: 'cooldown', counted: true, cooldownMs: 0, backoff: 'default', reason: kind || 'unknown' };
}

function exponential(base: number, max: number, count: number): number {
  return Math.min(max, base * 2 ** Math.max(0, count - 1));
}

function jittered(ms: number): number {
  return jitterCooldownMs(ms, Math.random());
}

function modelCooldownMs(model: Tier1ModelRuntime, outcome: Tier1Outcome): number {
  if (outcome.backoff === 'rate_limit') return Math.max(0, outcome.cooldownMs ?? 0);
  if ((outcome.cooldownMs ?? 0) > 0) {
    return Math.min(outcome.cooldownMs ?? 0, TIER1_COOLDOWN_MAX_MS);
  }
  if (outcome.backoff === 'timeout') return jittered(exponential(TIER1_TIMEOUT_BASE_MS, TIER1_TIMEOUT_MAX_MS, model.consecutiveFailures));
  if (outcome.backoff === 'server') return jittered(exponential(TIER1_5XX_BASE_MS, TIER1_5XX_MAX_MS, model.consecutiveFailures));
  return jittered(exponential(TIER1_COOLDOWN_DEFAULT_MS, TIER1_COOLDOWN_MAX_MS, model.consecutiveFailures));
}

export function applyTier1Outcome(accountId: string, modelId: string, outcome: Tier1Outcome | null | undefined, now: number = Date.now()): void {
  if (!outcome || outcome.action === 'neutral' || outcome.scope === 'none') return;
  const account = getTier1Account(accountId);

  if (outcome.scope === 'upstream_model') {
    const cooldownMs = Math.min(Math.max(0, outcome.cooldownMs ?? 0), TIER1_COOLDOWN_MAX_MS);
    if (cooldownMs > 0) {
      const until = now + cooldownMs;
      account.upstreamModelCooldowns.set(
        modelId,
        Math.max(account.upstreamModelCooldowns.get(modelId) ?? 0, until),
      );
    }
    return;
  }

  if (outcome.action === 'disable') {
    const ms = Math.max(0, outcome.cooldownMs ?? 0);
    if (ms > 0) {
      if (outcome.scope === 'account') {
        account.accountDisabled = false;
        account.accountCooldownUntil = Math.max(account.accountCooldownUntil, now + ms);
        account.accountCooldownReason = outcome.reason;
      } else {
        const model = getTier1Model(accountId, modelId);
        model.disabled = false;
        model.failureState = FAILURE_STATE.COOLDOWN;
        model.cooldownUntil = Math.max(model.cooldownUntil, now + ms);
        model.cooldownReason = outcome.reason;
      }
      return;
    }
    if (outcome.scope === 'account') {
      account.accountDisabled = true;
      account.accountCooldownReason = outcome.reason;
    } else {
      const model = getTier1Model(accountId, modelId);
      model.disabled = true;
      model.failureState = FAILURE_STATE.DISABLED;
      model.cooldownReason = outcome.reason;
    }
    return;
  }
  if (outcome.scope === 'account') {
    if (outcome.backoff === 'rate_limit') {
      const cooldownMs = Math.max(0, outcome.cooldownMs ?? 0);
      if (cooldownMs <= 0) return;
      account.consecutiveRateLimits++;
      if (outcome.scopeAmbiguous) account.scopeAmbiguous429 = true;
      account.accountCooldownUntil = Math.max(account.accountCooldownUntil, now + cooldownMs);
      account.accountCooldownReason = outcome.reason;
      account.rateLimitRecoveryPending = true;
      account.rateLimitRecoveryUntil = 0;
      return;
    }
    account.consecutiveAccountFailures++;
    account.accountCooldownUntil = Math.max(account.accountCooldownUntil, now + (outcome.cooldownMs || TIER1_COOLDOWN_DEFAULT_MS));
    account.accountCooldownReason = outcome.reason;
    return;
  }

  const rateLimited = outcome.backoff === 'rate_limit';
  if (rateLimited && (outcome.cooldownMs ?? 0) <= 0) return;
  const model = getTier1Model(accountId, modelId);
  if (outcome.scopeAmbiguous) model.scopeAmbiguous429 = true;
  if (rateLimited) model.consecutiveRateLimits++;
  else model.consecutiveRateLimits = 0;
  if (outcome.counted) model.consecutiveFailures++;

  const halfOpenFailure = model.failureState === FAILURE_STATE.HALF_OPEN;
  const thresholdReached = outcome.counted === true && model.consecutiveFailures >= TIER1_FAILURE_THRESHOLD;
  if (halfOpenFailure || thresholdReached || rateLimited || (outcome.cooldownMs ?? 0) > 0) {
    const cooldownMs = modelCooldownMs(model, outcome);
    model.cooldownUntil = now + cooldownMs;
    model.cooldownReason = outcome.reason;
    if (rateLimited) {
      model.rateLimitRecoveryPending = true;
      model.rateLimitRecoveryUntil = 0;
    }
    if (halfOpenFailure || thresholdReached) {
      model.failureState = FAILURE_STATE.COOLDOWN;
      model.halfOpenSuccesses = 0;
    }
  }
}

export function recordTier1Success(accountId: string, modelId: string, now: number = Date.now()): void {
  const account = getTier1Account(accountId);
  const model = getTier1Model(accountId, modelId);
  account.consecutiveAccountFailures = 0;

  const accountRecoveryProbe = account.accountCooldownReason === 'rate_limit'
    && account.accountCooldownUntil <= now
    && !account.rateLimitRecoveryPending
    && account.rateLimitRecoveryUntil > 0;
  if (accountRecoveryProbe) {
    account.consecutiveRateLimits = 0;
    account.accountCooldownUntil = 0;
    account.accountCooldownReason = null;
    account.scopeAmbiguous429 = false;
    account.rateLimitRecoveryPending = false;
    account.rateLimitRecoveryUntil = 0;
  }

  model.consecutiveFailures = 0;
  const modelRecoveryProbe = model.cooldownReason === 'rate_limit'
    && model.cooldownUntil <= now
    && !model.rateLimitRecoveryPending
    && model.rateLimitRecoveryUntil > 0;
  if (modelRecoveryProbe) {
    model.consecutiveRateLimits = 0;
    model.cooldownUntil = 0;
    model.cooldownReason = null;
    model.scopeAmbiguous429 = false;
    model.rateLimitRecoveryPending = false;
    model.rateLimitRecoveryUntil = 0;
  }
  if (model.failureState === FAILURE_STATE.HALF_OPEN) {
    model.halfOpenSuccesses++;
    if (model.halfOpenSuccesses >= TIER1_HALF_OPEN_SUCCESS_THRESHOLD) {
      model.failureState = FAILURE_STATE.NORMAL;
      model.halfOpenSuccesses = 0;
      model.cooldownUntil = 0;
      model.cooldownReason = null;
    }
  }
}

export function tier1FailureState(accountId: string, modelId: string): Tier1FailureState {
  return getTier1ModelPerf(accountId, modelId)?.failureState ?? FAILURE_STATE.NORMAL;
}

export function tier1BlockingWaitMs(node: RuntimeNode, modelId: string, now: number = Date.now()): number {
  const account = accounts.get(node.id);
  if (!account || account.accountDisabled) return Infinity;
  if (account.accountCooldownUntil > now) return account.accountCooldownUntil - now;
  if (account.rateLimitRecoveryUntil > now) return account.rateLimitRecoveryUntil - now;
  // A provider-reported quota window keeps the account ineligible until its
  // reset instant; surface that wait so client Retry-After reflects the real
  // boundary instead of a generic cooldown.
  if (account.quotaState === 'exhausted_until' && account.quotaResetAt > now) {
    return account.quotaResetAt - now;
  }
  const upstreamModelWait = upstreamModelCooldownRemainingMs(account, node, modelId, now);
  if (upstreamModelWait > 0) return upstreamModelWait;
  const model = account.models.get(modelId);
  if (model?.disabled) return Infinity;
  if (model && model.cooldownUntil > now) return model.cooldownUntil - now;
  if (model && model.rateLimitRecoveryUntil > now) return model.rateLimitRecoveryUntil - now;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return 1_000;
  return Infinity;
}

export function tier1HasDeferredCapacity(nodes: ReadonlyArray<RuntimeNode>, req: RoutableRequest, attempted: Set<string>, now: number = Date.now(), knownModels?: ReadonlySet<string> | null): boolean {
  for (const node of nodes ?? []) {
    if (attempted.has(node.id) || node.tier !== 'tier-1') continue;
    if (node.protocol !== req.protocol || !node.surfaces?.includes(req.surface) || !servesModel(node, req.model, knownModels)) continue;
    const account = accounts.get(node.id);
    if (!account || account.accountDisabled || account.accountCooldownUntil > now) continue;
    if (account.rateLimitRecoveryUntil > now) return true;
    if (upstreamModelCooldownRemainingMs(account, node, req.model, now) > 0) continue;
    const model = account.models.get(req.model);
    if (modelBlocked(model, now)) continue;
    if ((model?.rateLimitRecoveryUntil ?? 0) > now) return true;
    if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return true;
  }
  return false;
}

export function recordTier1QuotaSignal(accountId: string, signal: { remainingRatio?: number, resetAtMs?: number } = {}, now: number = Date.now()): boolean {
  const { remainingRatio, resetAtMs = 0 } = signal;
  if (typeof remainingRatio !== 'number' || !Number.isFinite(remainingRatio) || remainingRatio < 0 || remainingRatio > 1) return false;
  const account = getTier1Account(accountId);
  if (remainingRatio === 0 && resetAtMs > now) {
    account.quotaState = 'exhausted_until';
    account.quotaResetAt = resetAtMs;
  } else if (remainingRatio <= 0.1) {
    account.quotaState = 'near_limit';
  } else {
    account.quotaState = 'normal';
    account.quotaResetAt = 0;
  }
  return true;
}

/** Record a provider-reported quota window. This is the production writer that
 *  activates the dormant near_limit scoring and exhausted_until eligibility
 *  gate. Absolute remaining (requests/tokens) drives the reservation counter;
 *  the ratio (remaining/limit, when the provider reports a ceiling) drives the
 *  near_limit classification. A `null` signal (provider reports no quota) is
 *  ignored — unknown quota stays a no-op pass-through. */
export function recordTier1QuotaReport(
  accountId: string,
  signal: { remainingRequests?: number, remainingTokens?: number, limitRequests?: number, limitTokens?: number, resetAtMs?: number, source?: string } | null,
  now: number = Date.now(),
): boolean {
  if (!signal) return false;
  const account = getTier1Account(accountId);
  if (typeof signal.remainingRequests === 'number' && Number.isFinite(signal.remainingRequests) && signal.remainingRequests >= 0) {
    // The provider's report is the window tail; reservations already acquired in
    // this isolate are subtracted so new admission sees only what is genuinely
    // left. Reservations are honored even if a fresher (lower) report would
    // drop below them — the floor is zero, not negative.
    const reported = Math.trunc(signal.remainingRequests);
    account.quotaRemainingRequests = Math.max(0, reported - account.quotaReservedInFlight);
  }
  if (typeof signal.remainingTokens === 'number' && Number.isFinite(signal.remainingTokens) && signal.remainingTokens >= 0) {
    account.quotaRemainingTokens = Math.max(0, Math.trunc(signal.remainingTokens));
  }
  if (typeof signal.resetAtMs === 'number' && Number.isFinite(signal.resetAtMs) && signal.resetAtMs > now) {
    account.quotaResetAt = signal.resetAtMs;
  } else if (signal.remainingRequests === 0 || signal.remainingTokens === 0) {
    account.quotaResetAt = 0;
  }
  if (typeof signal.source === 'string' && signal.source) account.quotaSource = signal.source;

  const remaining = signal.remainingRequests ?? signal.remainingTokens;
  const limit = signal.limitRequests ?? signal.limitTokens;
  if (remaining === undefined) return true;
  const ratio = typeof limit === 'number' && limit > 0 ? remaining / limit : null;
  // Classification semantics match the ratio writer exactly: zero remaining
  // with a known reset is exhausted; a zero-or-tiny tail is near_limit even
  // without a reset marker; otherwise normal.
  if (remaining === 0 && account.quotaResetAt > now) {
    account.quotaState = 'exhausted_until';
  } else if (remaining === 0 || (ratio !== null ? ratio <= 0.1 : remaining <= 1)) {
    account.quotaState = 'near_limit';
  } else {
    account.quotaState = 'normal';
    if (account.quotaResetAt <= now) account.quotaResetAt = 0;
  }
  return true;
}

function modelDiagnosticState(model: Tier1ModelRuntime | null | undefined, now: number): string {
  if (!model) return 'configured';
  if (model.disabled || model.failureState === FAILURE_STATE.DISABLED) return 'disabled';
  if (model.cooldownUntil > now || model.failureState === FAILURE_STATE.COOLDOWN) return 'cooldown';
  if (model.failureState === FAILURE_STATE.HALF_OPEN) return 'half_open';
  if (model.sampleCount > 0) return 'observed_healthy';
  return 'unknown';
}

export function snapshotTier1Runtime(accountId: string, modelId: string, now: number = Date.now()) {
  const account = accounts.get(accountId);
  const model = account?.models.get(modelId);
  return {
    account_id: accountId,
    model: modelId,
    state: account?.accountDisabled ? 'disabled'
      : account && account.accountCooldownUntil > now ? 'cooldown'
      : modelDiagnosticState(model, now),
    account_disabled: account?.accountDisabled ?? false,
    account_cooldown_remaining_ms: account && account.accountCooldownUntil > now ? account.accountCooldownUntil - now : 0,
    account_consecutive_rate_limits: account?.consecutiveRateLimits ?? 0,
    account_scope_ambiguous_429: account?.scopeAmbiguous429 ?? false,
    in_flight: account?.inFlight ?? 0,
    quota_state: account?.quotaState === 'exhausted_until' && (account?.quotaResetAt ?? 0) <= now
      ? 'normal' : account?.quotaState ?? 'normal',
    quota_reset_at: account && account.quotaResetAt > now ? new Date(account.quotaResetAt).toISOString() : null,
    failure_state: model?.failureState ?? FAILURE_STATE.NORMAL,
    consecutive_failures: model?.consecutiveFailures ?? 0,
    consecutive_rate_limits: model?.consecutiveRateLimits ?? 0,
    consecutive_outliers: model?.consecutiveOutliers ?? 0,
    half_open_successes: model?.halfOpenSuccesses ?? 0,
    cooldown_remaining_ms: model && model.cooldownUntil > now ? model.cooldownUntil - now : 0,
    cooldown_reason: model && model.cooldownUntil > now ? model.cooldownReason : null,
    ttft_ewma_ms: model?.ttftEwma == null ? null : Math.round(model.ttftEwma),
    sample_count: model?.sampleCount ?? 0,
    last_observed_at: model && model.lastObservedAt > 0 ? new Date(model.lastObservedAt).toISOString() : null,
    scope_ambiguous_429: model?.scopeAmbiguous429 ?? false,
  };
}

export function snapshotTier1AccountRuntime(accountId: string, modelIds: ReadonlyArray<string> = [], now: number = Date.now()) {
  const account = accounts.get(accountId);
  const ids = new Set(modelIds);
  for (const id of account?.models.keys() ?? []) ids.add(id);
  const models = [...ids].sort().map((id) => snapshotTier1Runtime(accountId, id, now));
  return {
    state: account?.accountDisabled ? 'disabled'
      : account && account.accountCooldownUntil > now ? 'cooldown'
      : models.some((m) => m.state === 'observed_healthy') ? 'observed_healthy'
      : account ? 'unknown' : 'configured',
    in_flight: account?.inFlight ?? 0,
    account_disabled: account?.accountDisabled ?? false,
    account_cooldown_remaining_ms: account && account.accountCooldownUntil > now ? account.accountCooldownUntil - now : 0,
    consecutive_rate_limits: account?.consecutiveRateLimits ?? 0,
    scope_ambiguous_429: account?.scopeAmbiguous429 ?? false,
    models,
  };
}

export function __resetTier1StateForTests(): void {
  accounts.clear();
}

export const TIER1_FAILURE_STATES = FAILURE_STATE;
