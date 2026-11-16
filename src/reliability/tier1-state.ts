import { resolvePhysicalModel } from '../config/registry.ts';
import { RUNTIME_TUNABLES } from '../config/runtime-vars.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { RoutableRequest } from '../types/scheduler.ts';
import { cryptoRng } from '../utils/crypto-rng.ts';
import { jitterCooldownMs } from './cooldown-jitter.ts';
import {
  FAILURE_STATE,
  TIER1_5XX_BASE_MS,
  TIER1_5XX_MAX_MS,
  TIER1_429_ACCOUNT_ESCALATION_MODELS,
  TIER1_429_ACCOUNT_ESCALATION_WINDOW_MS,
  TIER1_429_PROBE_GATE_MS,
  TIER1_CIRCUIT_COOLDOWN_FLOOR_MS,
  TIER1_COOLDOWN_DEFAULT_MS,
  TIER1_COOLDOWN_MAX_MS,
  TIER1_EWMA_ALPHA,
  TIER1_FAILURE_STREAK_WINDOW_MS,
  TIER1_FAILURE_THRESHOLD,
  TIER1_FAST_COOLDOWN_MS,
  TIER1_FORBIDDEN_LADDER_MS,
  TIER1_HALF_OPEN_SUCCESS_THRESHOLD,
  TIER1_MODEL_MISSING_LADDER_MS,
  TIER1_OUTLIER_CONSECUTIVE_THRESHOLD,
  TIER1_OUTLIER_MULTIPLIER,
  TIER1_OVERSIZE_MEMORY_MS,
  TIER1_SIBLING_WAKE_MIN_REMAINING_MS,
  TIER1_TIMEOUT_BASE_MS,
  TIER1_TIMEOUT_MAX_MS,
  type Tier1AccountRuntime,
  type Tier1FailureState,
  type Tier1ModelRuntime,
  type Tier1Outcome,
  type Tier1ReleaseToken,
  type Tier1SharedCooldown,
} from './tier1-definitions.ts';
import { normalizeQuotaWindow } from './tier1-quota.ts';
import { tier1Accounts as accounts, getTier1Account, getTier1Model, getTier1ModelPerf, resetTier1StoreForTests } from './tier1-store.ts';

export { classifyTier1Failure } from './tier1-decision.ts';
export type {
  Tier1AccountRuntime,
  Tier1FailureInput,
  Tier1FailureState,
  Tier1ModelRuntime,
  Tier1Outcome,
  Tier1QuotaState,
  Tier1ReleaseToken,
  Tier1SharedCooldown,
} from './tier1-definitions.ts';
export {
  TIER1_5XX_BASE_MS,
  TIER1_5XX_MAX_MS,
  TIER1_429_ACCOUNT_ESCALATION_MODELS,
  TIER1_429_ACCOUNT_ESCALATION_WINDOW_MS,
  TIER1_429_PROBE_GATE_MS,
  TIER1_CIRCUIT_COOLDOWN_FLOOR_MS,
  TIER1_COOLDOWN_DEFAULT_MS,
  TIER1_COOLDOWN_MAX_MS,
  TIER1_EWMA_ALPHA,
  TIER1_FAILURE_STATES,
  TIER1_FAILURE_STREAK_WINDOW_MS,
  TIER1_FAILURE_THRESHOLD,
  TIER1_FAST_COOLDOWN_MS,
  TIER1_FORBIDDEN_LADDER_MS,
  TIER1_HALF_OPEN_SUCCESS_THRESHOLD,
  TIER1_MODEL_MISSING_LADDER_MS,
  TIER1_OUTLIER_CONSECUTIVE_THRESHOLD,
  TIER1_OUTLIER_MULTIPLIER,
  TIER1_OVERSIZE_MEMORY_MS,
  TIER1_SIBLING_WAKE_MIN_REMAINING_MS,
  TIER1_TIMEOUT_BASE_MS,
  TIER1_TIMEOUT_MAX_MS,
} from './tier1-definitions.ts';
export { snapshotTier1AccountRuntime, snapshotTier1Runtime, tier1LongCooldowns } from './tier1-diagnostics.ts';
export { recordTier1QuotaReport, recordTier1QuotaSignal, settleTier1Quota, tier1QuotaState } from './tier1-quota.ts';
export { getTier1Account, getTier1Model, getTier1ModelPerf, tier1AccountInFlight } from './tier1-store.ts';

const PROBE_TIMEOUT_TUNABLE = RUNTIME_TUNABLES.find((entry) => entry.name === 'AIG_TIER1_PROBE_TIMEOUT_MS') ?? null;

type RateLimitProbeScope = { rateLimitRecoveryUntil: number };

const probeGate: { v2: boolean; timeoutMs: number } = {
  v2: false,
  timeoutMs: PROBE_TIMEOUT_TUNABLE?.def ?? TIER1_429_PROBE_GATE_MS,
};

export function configureTier1ProbeGate(cfg: { v2?: boolean; timeoutMs?: number } = {}): void {
  probeGate.v2 = cfg.v2 === true;
  if (typeof cfg.timeoutMs === 'number' && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0) {
    const max = PROBE_TIMEOUT_TUNABLE?.max ?? 30_000;
    probeGate.timeoutMs = Math.min(Math.max(Math.round(cfg.timeoutMs), 1_000), max);
  } else {
    probeGate.timeoutMs = PROBE_TIMEOUT_TUNABLE?.def ?? TIER1_429_PROBE_GATE_MS;
  }
}

function tier1UpstreamModelOf(node: RuntimeNode, logicalModel: string): string {
  return node.models[logicalModel] || logicalModel;
}

function upstreamModelCooldownRemainingMs(account: Tier1AccountRuntime, node: RuntimeNode, logicalModel: string, now: number): number {
  const until = account.upstreamModelCooldowns.get(tier1UpstreamModelOf(node, logicalModel)) ?? 0;
  return until > now ? until - now : 0;
}

function recoveryGateMs(): number {
  if (!probeGate.v2) return TIER1_429_PROBE_GATE_MS;
  return jittered(probeGate.timeoutMs);
}

function rateLimitProbeBlocked(scope: RateLimitProbeScope, scopeInFlight: number, now: number): boolean {
  if (scope.rateLimitRecoveryUntil <= now) return false;
  if (!probeGate.v2) return true;
  return scopeInFlight > 0;
}

export function claimTier1Slot(
  node: RuntimeNode,
  now: number = Date.now(),
  modelId: string | null = null,
  maxInFlight: number | null = null,
): boolean {
  const account = getTier1Account(node.id);
  account.provider = node.provider;
  normalizeQuotaWindow(account, now);
  if (account.accountDisabled || account.accountCooldownUntil > now) return false;
  if (rateLimitProbeBlocked(account, account.inFlight, now)) return false;
  const model = modelId ? account.models.get(modelId) : null;
  if (modelId && upstreamModelCooldownRemainingMs(account, node, modelId, now) > 0) return false;
  if (model && rateLimitProbeBlocked(model, model.inFlight, now)) return false;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && model.inFlight > 0) return false;
  if (maxInFlight !== null && account.inFlight >= maxInFlight) return false;
  if (account.quotaRemainingRequests !== null && account.quotaRemainingRequests <= 0) return false;
  account.inFlight++;
  if (modelId) getTier1Model(node.id, modelId).inFlight++;
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

export function makeTier1ReleaseToken(accountId: string, modelId: string | null = null): Tier1ReleaseToken {
  const account = accounts.get(accountId);
  const reserved = account && account.quotaRemainingRequests !== null ? 1 : 0;
  return { accountId, modelId, released: false, settled: false, quotaReserved: reserved };
}

export function releaseTier1Slot(accountId: string, token: Tier1ReleaseToken | null | undefined): boolean {
  if (!token || token.accountId !== accountId || token.released) return false;
  token.released = true;
  const account = accounts.get(accountId);
  if (account) {
    account.inFlight = Math.max(0, account.inFlight - 1);
    const model = token.modelId ? account.models.get(token.modelId) : null;
    if (model) model.inFlight = Math.max(0, model.inFlight - 1);
    if (!token.settled && token.quotaReserved > 0 && account.quotaReservedInFlight > 0) {
      account.quotaReservedInFlight--;
      if (account.quotaRemainingRequests !== null) account.quotaRemainingRequests++;
    }
  }
  return true;
}

function modelBlocked(model: Tier1ModelRuntime | null | undefined, now: number): boolean {
  return model?.disabled || (model?.cooldownUntil ?? 0) > now;
}

export function isTier1Eligible(
  node: RuntimeNode,
  req: RoutableRequest,
  now: number = Date.now(),
  knownModels?: ReadonlySet<string> | null,
  maxInFlight?: number | null,
): boolean {
  if (node?.tier !== 'tier-1') return false;
  if (node.protocol !== req.protocol) return false;
  if (!Array.isArray(node.surfaces) || !node.surfaces.includes(req.surface)) return false;
  if (!resolvePhysicalModel(node, req.model, knownModels)) return false;
  const account = accounts.get(node.id);
  if (!account) return true;
  normalizeQuotaWindow(account, now);
  if (account.accountDisabled || account.accountCooldownUntil > now) return false;
  if (rateLimitProbeBlocked(account, account.inFlight, now)) return false;
  if (upstreamModelCooldownRemainingMs(account, node, req.model, now) > 0) return false;
  const model = account.models.get(req.model);
  if (modelBlocked(model, now) || (model && rateLimitProbeBlocked(model, model.inFlight, now))) return false;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && model.inFlight > 0) return false;
  if (exceedsOversizeCeiling(account, req.model, req.bodyChars, now)) return false;
  if (account.quotaState === 'exhausted_until' && account.quotaResetAt > now) return false;
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

export function tier1CountDispatchableNodes(
  nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number = Date.now(),
  knownModels?: ReadonlySet<string> | null,
  maxInFlight?: number | null,
): number {
  let count = 0;
  for (const node of nodes ?? []) {
    if (attempted.has(node.id)) continue;
    maybeTransitionToHalfOpen(node.id, req.model, now);
    if (isTier1Eligible(node, req, now, knownModels, maxInFlight)) count++;
  }
  return count;
}

export function tier1HasDispatchableNode(
  nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number = Date.now(),
  knownModels?: ReadonlySet<string> | null,
  maxInFlight?: number | null,
): boolean {
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
    model.ttftEwma = TIER1_EWMA_ALPHA * effectiveSample + (1 - TIER1_EWMA_ALPHA) * model.ttftEwma;
  }
  model.sampleCount++;
  model.lastObservedAt = now;
  return true;
}

function exponential(base: number, max: number, count: number): number {
  return Math.min(max, base * 2 ** Math.max(0, count - 1));
}

function jittered(ms: number): number {
  return jitterCooldownMs(ms, cryptoRng());
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

export function wakeTier1ProviderSiblings(provider: string, recoveredAccountId: string, modelId: string, now: number = Date.now()): string[] {
  const woken: string[] = [];
  for (const [id, account] of accounts) {
    if (id === recoveredAccountId || account.provider !== provider || account.accountDisabled) continue;
    if (
      account.accountCooldownReason === 'rate_limit' &&
      !account.accountCooldownIsQuota &&
      account.accountCooldownUntil - now >= TIER1_SIBLING_WAKE_MIN_REMAINING_MS
    ) {
      account.accountCooldownUntil = now;
      woken.push(id);
    }
    const model = account.models.get(modelId);
    if (model?.cooldownReason === 'rate_limit' && !model.cooldownIsQuota && model.cooldownUntil - now >= TIER1_SIBLING_WAKE_MIN_REMAINING_MS) {
      model.cooldownUntil = now;
      if (!woken.includes(id)) woken.push(id);
    }
  }
  return woken;
}

export function recordTier1UpstreamModelServed(accountId: string, upstreamModel: string): void {
  accounts.get(accountId)?.upstreamModelMisses.delete(upstreamModel);
}

export function recordTier1Oversize(accountId: string, modelId: string, requestChars: number, now: number = Date.now()): void {
  if (!Number.isFinite(requestChars) || requestChars <= 0) return;
  const account = getTier1Account(accountId);
  const known = account.oversizeCeilings.get(modelId);
  const chars = known && known.until > now ? Math.min(known.chars, requestChars) : requestChars;
  account.oversizeCeilings.set(modelId, { chars, until: now + TIER1_OVERSIZE_MEMORY_MS });
}

function exceedsOversizeCeiling(account: Tier1AccountRuntime, modelId: string, requestChars: number | undefined, now: number): boolean {
  if (!requestChars || account.oversizeCeilings.size === 0) return false;
  const ceiling = account.oversizeCeilings.get(modelId);
  if (!ceiling) return false;
  if (ceiling.until <= now) {
    account.oversizeCeilings.delete(modelId);
    return false;
  }
  return requestChars >= ceiling.chars;
}

export function decideTier1RateLimitScope(accountId: string, modelId: string, now: number = Date.now()): 'model' | 'account' {
  const account = getTier1Account(accountId);
  const cutoff = now - TIER1_429_ACCOUNT_ESCALATION_WINDOW_MS;
  for (const [id, at] of account.recentRateLimitedModels) {
    if (at <= cutoff) account.recentRateLimitedModels.delete(id);
  }
  account.recentRateLimitedModels.set(modelId, now);
  if (account.consecutiveRateLimits > 0 || account.accountCooldownUntil > now) return 'account';
  return account.recentRateLimitedModels.size >= TIER1_429_ACCOUNT_ESCALATION_MODELS ? 'account' : 'model';
}

export function applyTier1Outcome(accountId: string, modelId: string, outcome: Tier1Outcome | null | undefined, now: number = Date.now()): void {
  if (!outcome || outcome.action === 'neutral' || outcome.scope === 'none') return;
  const account = getTier1Account(accountId);

  if (outcome.scope === 'upstream_model') {
    const lapsed = (account.upstreamModelCooldowns.get(modelId) ?? 0) <= now;
    const misses = (account.upstreamModelMisses.get(modelId) ?? 0) + (lapsed ? 1 : 0);
    account.upstreamModelMisses.set(modelId, Math.max(1, misses));
    const ladderMs = TIER1_MODEL_MISSING_LADDER_MS[Math.min(Math.max(1, misses), TIER1_MODEL_MISSING_LADDER_MS.length) - 1] ?? 0;
    const cooldownMs = Math.min(Math.max(0, outcome.cooldownMs ?? 0, ladderMs), TIER1_COOLDOWN_MAX_MS);
    if (cooldownMs > 0) {
      const until = now + cooldownMs;
      account.upstreamModelCooldowns.set(modelId, Math.max(account.upstreamModelCooldowns.get(modelId) ?? 0, until));
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
      account.accountCooldownIsQuota = outcome.isQuota === true;
      account.rateLimitRecoveryPending = true;
      account.rateLimitRecoveryUntil = 0;
      return;
    }
    account.consecutiveAccountFailures++;
    account.accountCooldownUntil = Math.max(account.accountCooldownUntil, now + (outcome.cooldownMs || TIER1_COOLDOWN_DEFAULT_MS));
    account.accountCooldownReason = outcome.reason;
    return;
  }

  if (outcome.backoff === 'forbidden') {
    const model = getTier1Model(accountId, modelId);
    if (model.cooldownUntil <= now) model.consecutiveForbidden++;
    const ceiling = Math.max(0, outcome.cooldownMs ?? 0);
    const step = TIER1_FORBIDDEN_LADDER_MS[model.consecutiveForbidden - 1];
    const cooldownMs = step === undefined ? ceiling : Math.min(step, ceiling);
    if (cooldownMs > 0) {
      model.cooldownUntil = Math.max(model.cooldownUntil, now + cooldownMs);
      model.cooldownReason = outcome.reason;
    }
    return;
  }

  const rateLimited = outcome.backoff === 'rate_limit';
  if (rateLimited && (outcome.cooldownMs ?? 0) <= 0) return;
  const model = getTier1Model(accountId, modelId);
  if (outcome.scopeAmbiguous) model.scopeAmbiguous429 = true;
  if (rateLimited) model.consecutiveRateLimits++;
  else model.consecutiveRateLimits = 0;
  if (outcome.counted) {
    if (model.lastCountedFailureAt === 0 || now - model.lastCountedFailureAt > TIER1_FAILURE_STREAK_WINDOW_MS) {
      model.consecutiveFailures = 0;
    }
    model.consecutiveFailures++;
    model.lastCountedFailureAt = now;
  }

  const halfOpenFailure = model.failureState === FAILURE_STATE.HALF_OPEN;
  const thresholdReached = outcome.counted === true && model.consecutiveFailures >= TIER1_FAILURE_THRESHOLD;
  const fastCooldown = outcome.counted === true && model.consecutiveFailures === 2 && !halfOpenFailure;
  if (halfOpenFailure || thresholdReached || fastCooldown || rateLimited || (outcome.cooldownMs ?? 0) > 0) {
    const cooldownMs =
      !rateLimited && (halfOpenFailure || thresholdReached)
        ? Math.max(TIER1_CIRCUIT_COOLDOWN_FLOOR_MS, modelCooldownMs(model, outcome))
        : fastCooldown
          ? Math.max(TIER1_FAST_COOLDOWN_MS, modelCooldownMs(model, outcome))
          : modelCooldownMs(model, outcome);
    model.cooldownUntil = Math.max(model.cooldownUntil, now + cooldownMs);
    model.cooldownReason = outcome.reason;
    if (rateLimited) {
      model.rateLimitRecoveryPending = true;
      model.rateLimitRecoveryUntil = 0;
      model.cooldownIsQuota = outcome.isQuota === true;
    }
    if (halfOpenFailure || thresholdReached || fastCooldown) {
      model.failureState = FAILURE_STATE.COOLDOWN;
      model.halfOpenSuccesses = 0;
    }
  }
}

function clearRateLimitRecoveryIfProven(account: Tier1AccountRuntime, model: Tier1ModelRuntime, now: number): void {
  const accountRecoveryProbe =
    account.accountCooldownReason === 'rate_limit' &&
    account.accountCooldownUntil <= now &&
    !account.rateLimitRecoveryPending &&
    account.rateLimitRecoveryUntil > 0;
  if (accountRecoveryProbe) {
    account.consecutiveRateLimits = 0;
    account.accountCooldownUntil = 0;
    account.accountCooldownReason = null;
    account.scopeAmbiguous429 = false;
    account.rateLimitRecoveryPending = false;
    account.rateLimitRecoveryUntil = 0;
    account.accountCooldownIsQuota = false;
  }
  const modelRecoveryProbe =
    model.cooldownReason === 'rate_limit' && model.cooldownUntil <= now && !model.rateLimitRecoveryPending && model.rateLimitRecoveryUntil > 0;
  if (modelRecoveryProbe) {
    model.consecutiveRateLimits = 0;
    model.cooldownUntil = 0;
    model.cooldownReason = null;
    model.scopeAmbiguous429 = false;
    model.rateLimitRecoveryPending = false;
    model.rateLimitRecoveryUntil = 0;
    model.cooldownIsQuota = false;
  }
}

export function commitTier1RecoveryProbe(accountId: string, modelId: string, now: number = Date.now()): boolean {
  if (!probeGate.v2) return false;
  const account = getTier1Account(accountId);
  const model = getTier1Model(accountId, modelId);
  const armedBefore =
    (account.accountCooldownReason === 'rate_limit' && account.rateLimitRecoveryUntil > 0) ||
    (model.cooldownReason === 'rate_limit' && model.rateLimitRecoveryUntil > 0);
  clearRateLimitRecoveryIfProven(account, model, now);
  const armedAfter =
    (account.accountCooldownReason === 'rate_limit' && account.rateLimitRecoveryUntil > 0) ||
    (model.cooldownReason === 'rate_limit' && model.rateLimitRecoveryUntil > 0);
  return armedBefore && !armedAfter;
}

export function recordTier1Success(accountId: string, modelId: string, now: number = Date.now()): void {
  const account = getTier1Account(accountId);
  const model = getTier1Model(accountId, modelId);
  account.consecutiveAccountFailures = 0;

  clearRateLimitRecoveryIfProven(account, model, now);

  model.consecutiveFailures = 0;
  model.lastCountedFailureAt = 0;
  model.consecutiveForbidden = 0;
  account.recentRateLimitedModels.delete(modelId);
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
  if (account.quotaState === 'exhausted_until' && account.quotaResetAt > now) {
    return account.quotaResetAt - now;
  }
  const upstreamModelWait = upstreamModelCooldownRemainingMs(account, node, modelId, now);
  if (upstreamModelWait > 0) return upstreamModelWait;
  const model = account.models.get(modelId);
  if (model?.disabled) return Infinity;
  if (model && model.cooldownUntil > now) return model.cooldownUntil - now;
  if (model && model.rateLimitRecoveryUntil > now) return model.rateLimitRecoveryUntil - now;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && model.inFlight > 0) return 1_000;
  return Infinity;
}

export function tier1HasDeferredCapacity(
  nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number = Date.now(),
  knownModels?: ReadonlySet<string> | null,
): boolean {
  for (const node of nodes ?? []) {
    if (attempted.has(node.id) || node.tier !== 'tier-1') continue;
    if (node.protocol !== req.protocol || !node.surfaces?.includes(req.surface) || !resolvePhysicalModel(node, req.model, knownModels)) continue;
    const account = accounts.get(node.id);
    if (!account || account.accountDisabled || account.accountCooldownUntil > now) continue;
    if (account.rateLimitRecoveryUntil > now) return true;
    if (upstreamModelCooldownRemainingMs(account, node, req.model, now) > 0) continue;
    const model = account.models.get(req.model);
    if (modelBlocked(model, now)) continue;
    if ((model?.rateLimitRecoveryUntil ?? 0) > now) return true;
    if (model?.failureState === FAILURE_STATE.HALF_OPEN && model.inFlight > 0) return true;
  }
  return false;
}

export function adoptTier1Cooldown(entry: Tier1SharedCooldown, now: number = Date.now()): void {
  if (!(entry.until > now)) return;
  if (entry.model) {
    const model = getTier1Model(entry.node, entry.model);
    if (entry.until > model.cooldownUntil) {
      model.cooldownUntil = entry.until;
      model.cooldownReason = entry.reason;
    }
    return;
  }
  const account = getTier1Account(entry.node);
  if (entry.until <= account.accountCooldownUntil) return;
  account.accountCooldownUntil = entry.until;
  account.accountCooldownReason = entry.reason;
  if (entry.reason === 'rate_limit') {
    account.accountCooldownIsQuota = entry.quota === true;
    account.rateLimitRecoveryPending = true;
    account.rateLimitRecoveryUntil = 0;
  }
}

export function __resetTier1StateForTests(): void {
  resetTier1StoreForTests();
}
