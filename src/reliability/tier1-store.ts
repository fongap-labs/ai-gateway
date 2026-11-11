// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { FAILURE_STATE, type Tier1AccountRuntime, type Tier1ModelRuntime } from './tier1-definitions.ts';

const accounts = new Map<string, Tier1AccountRuntime>();
// Readers share one store; only the store itself owns map insertion and clearing.
export const tier1Accounts: ReadonlyMap<string, Tier1AccountRuntime> = accounts;

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

export function resetTier1StoreForTests(): void {
  accounts.clear();
}
