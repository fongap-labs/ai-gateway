// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { Tier1AccountRuntime, Tier1QuotaState, Tier1ReleaseToken } from './tier1-definitions.ts';
import { tier1Accounts as accounts, getTier1Account } from './tier1-store.ts';

export function tier1QuotaState(accountId: string, now: number = Date.now()): Tier1QuotaState {
  const account = accounts.get(accountId);
  if (!account) return 'normal';
  if (account.quotaState === 'exhausted_until' && account.quotaResetAt <= now) return 'normal';
  return account.quotaState;
}

export function normalizeQuotaWindow(account: Tier1AccountRuntime, now: number): void {
  if (account.quotaResetAt > 0 && account.quotaResetAt <= now) {
    account.quotaResetAt = 0;
    account.quotaState = 'normal';
    account.quotaRemainingRequests = null;
    account.quotaRemainingTokens = null;
  }
}

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

export function recordTier1QuotaSignal(
  accountId: string,
  signal: { remainingRatio?: number; resetAtMs?: number } = {},
  now: number = Date.now(),
): boolean {
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

export function recordTier1QuotaReport(
  accountId: string,
  signal: {
    remainingRequests?: number;
    remainingTokens?: number;
    limitRequests?: number;
    limitTokens?: number;
    resetAtMs?: number;
    source?: string;
  } | null,
  now: number = Date.now(),
): boolean {
  if (!signal) return false;
  const account = getTier1Account(accountId);
  if (typeof signal.remainingRequests === 'number' && Number.isFinite(signal.remainingRequests) && signal.remainingRequests >= 0) {
    const reported = Math.trunc(signal.remainingRequests);
    account.quotaRemainingRequests = Math.max(0, reported - account.quotaReservedInFlight);
  }
  if (typeof signal.remainingTokens === 'number' && Number.isFinite(signal.remainingTokens) && signal.remainingTokens >= 0) {
    account.quotaRemainingTokens = Math.max(0, Math.trunc(signal.remainingTokens));
  }
  if (typeof signal.resetAtMs === 'number' && Number.isFinite(signal.resetAtMs) && signal.resetAtMs > now) {
    account.quotaResetAt = signal.resetAtMs;
  } else if (account.quotaResetAt <= now && (signal.remainingRequests === 0 || signal.remainingTokens === 0)) {
    account.quotaResetAt = 0;
  }
  if (typeof signal.source === 'string' && signal.source) account.quotaSource = signal.source;

  const remaining = signal.remainingRequests ?? signal.remainingTokens;
  if (remaining === undefined) return true;
  const tails = [quotaTailRatio(signal.remainingRequests, signal.limitRequests), quotaTailRatio(signal.remainingTokens, signal.limitTokens)].filter(
    (tail): tail is number => tail !== null,
  );
  if (tails.length === 0) return true;
  const worstTail = Math.min(...tails);
  const exhausted = tails.some((tail) => tail === 0);
  if (exhausted && account.quotaResetAt > now) {
    account.quotaState = 'exhausted_until';
  } else if (exhausted || worstTail <= 0.1) {
    account.quotaState = 'near_limit';
    if (account.quotaResetAt <= now) {
      if (signal.remainingRequests === 0) account.quotaRemainingRequests = null;
      if (signal.remainingTokens === 0) account.quotaRemainingTokens = null;
    }
  } else {
    account.quotaState = 'normal';
    if (account.quotaResetAt <= now) account.quotaResetAt = 0;
  }
  return true;
}

function quotaTailRatio(remaining: number | undefined, limit: number | undefined): number | null {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) return remaining / limit;
  if (remaining <= 0) return 0;
  if (remaining <= 1) return 0.1;
  return 1;
}
