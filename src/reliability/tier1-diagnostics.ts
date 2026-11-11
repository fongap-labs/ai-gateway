// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Read-only Tier 1 diagnostic projections, no state allocation or mutations.

import { FAILURE_STATE, type Tier1AccountRuntime, type Tier1ModelRuntime } from './tier1-contract.ts';

function modelDiagnosticState(model: Tier1ModelRuntime | null | undefined, now: number): string {
  if (!model) return 'configured';
  if (model.disabled || model.failureState === FAILURE_STATE.DISABLED) return 'disabled';
  if (model.cooldownUntil > now || model.failureState === FAILURE_STATE.COOLDOWN) return 'cooldown';
  if (model.failureState === FAILURE_STATE.HALF_OPEN) return 'half_open';
  if (model.sampleCount > 0) return 'observed_healthy';
  return 'unknown';
}

export function snapshotTier1RuntimeState(accountId: string, modelId: string, account: Tier1AccountRuntime | undefined, now: number) {
  const model = account?.models.get(modelId);
  return {
    account_id: accountId,
    model: modelId,
    state: account?.accountDisabled ? 'disabled' : account && account.accountCooldownUntil > now ? 'cooldown' : modelDiagnosticState(model, now),
    account_disabled: account?.accountDisabled ?? false,
    account_cooldown_remaining_ms: account && account.accountCooldownUntil > now ? account.accountCooldownUntil - now : 0,
    account_consecutive_rate_limits: account?.consecutiveRateLimits ?? 0,
    account_scope_ambiguous_429: account?.scopeAmbiguous429 ?? false,
    in_flight: account?.inFlight ?? 0,
    quota_state: account?.quotaState === 'exhausted_until' && (account?.quotaResetAt ?? 0) <= now ? 'normal' : (account?.quotaState ?? 'normal'),
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

export function snapshotTier1AccountRuntimeState(accountId: string, modelIds: ReadonlyArray<string>, account: Tier1AccountRuntime | undefined, now: number) {
  const ids = new Set(modelIds);
  for (const id of account?.models.keys() ?? []) ids.add(id);
  const models = [...ids].sort().map((id) => snapshotTier1RuntimeState(accountId, id, account, now));
  return {
    state: account?.accountDisabled
      ? 'disabled'
      : account && account.accountCooldownUntil > now
        ? 'cooldown'
        : models.some((m) => m.state === 'observed_healthy')
          ? 'observed_healthy'
          : account
            ? 'unknown'
            : 'configured',
    in_flight: account?.inFlight ?? 0,
    account_disabled: account?.accountDisabled ?? false,
    account_cooldown_remaining_ms: account && account.accountCooldownUntil > now ? account.accountCooldownUntil - now : 0,
    consecutive_rate_limits: account?.consecutiveRateLimits ?? 0,
    scope_ambiguous_429: account?.scopeAmbiguous429 ?? false,
    models,
  };
}
/**
 * A cooldown another isolate should honour: evidence that outlives this isolate
 * and is never cleared early. A credential rejection (401) or long-lived quota
 * on the account, or an escalated 403 refusal on one model. Short rate-limit
 * windows are not shared: a recovering sibling key may wake them early.
 */
export type Tier1SharedCooldown = { node: string; model?: string; until: number; reason: string; quota?: boolean };

export function readTier1LongCooldowns(accountId: string, account: Tier1AccountRuntime | undefined, minRemainingMs: number, now: number): Tier1SharedCooldown[] {
  if (!account) return [];
  const out: Tier1SharedCooldown[] = [];
  const accountReason = account.accountCooldownReason;
  const isLongLived = accountReason === 'auth' || (accountReason === 'rate_limit' && account.accountCooldownIsQuota);
  if (isLongLived && accountReason && account.accountCooldownUntil - now >= minRemainingMs) {
    out.push({
      node: accountId,
      until: account.accountCooldownUntil,
      reason: accountReason,
      ...(account.accountCooldownIsQuota ? { quota: true } : {}),
    });
  }
  for (const [modelId, model] of account.models) {
    if (model.cooldownReason === 'auth' && model.cooldownUntil - now >= minRemainingMs) {
      out.push({ node: accountId, model: modelId, until: model.cooldownUntil, reason: 'auth' });
    }
  }
  return out;
}
