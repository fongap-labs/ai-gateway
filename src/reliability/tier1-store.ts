// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// The sole isolate-local Tier 1 account map. Mutations and admission policy
// remain orchestrated through tier1-state.ts, the sole public write facade.

import { FAILURE_STATE, type Tier1AccountRuntime, type Tier1ModelRuntime } from './tier1-contract.ts';

const accounts = new Map<string, Tier1AccountRuntime>();

function newModelRuntime(): Tier1ModelRuntime {
  return {
    supported: true,
    inFlight: 0,
    disabled: false,
    cooldownUntil: 0,
    cooldownReason: null,
    failureState: FAILURE_STATE.NORMAL,
    consecutiveFailures: 0,
    consecutiveRateLimits: 0,
    consecutiveOutliers: 0,
    consecutiveForbidden: 0,
    halfOpenSuccesses: 0,
    ttftEwma: null,
    sampleCount: 0,
    lastObservedAt: 0,
    scopeAmbiguous429: false,
    rateLimitRecoveryPending: false,
    rateLimitRecoveryUntil: 0,
    cooldownIsQuota: false,
  };
}

function newAccountRuntime(accountId: string): Tier1AccountRuntime {
  return {
    accountId,
    provider: null,
    inFlight: 0,
    accountDisabled: false,
    accountCooldownUntil: 0,
    accountCooldownReason: null,
    consecutiveAccountFailures: 0,
    consecutiveRateLimits: 0,
    scopeAmbiguous429: false,
    rateLimitRecoveryPending: false,
    rateLimitRecoveryUntil: 0,
    accountCooldownIsQuota: false,
    recentRateLimitedModels: new Map(),
    oversizeCeilings: new Map(),
    upstreamModelMisses: new Map(),
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


/** Internal read: never creates runtime state just to build a diagnostic. */
export function peekTier1Account(accountId: string): Tier1AccountRuntime | undefined {
  return accounts.get(accountId);
}

/** Iterate the one existing map; no mirror cache or independently mutable map. */
export function allTier1Accounts(): IterableIterator<[string, Tier1AccountRuntime]> {
  return accounts.entries();
}

export function resetTier1AccountsForTests(): void {
  accounts.clear();
}
