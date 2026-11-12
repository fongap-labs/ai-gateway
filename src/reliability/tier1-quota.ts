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

// A provider-reported window that has rolled over is stale: the old remaining
// tail is meaningless and must not keep the account blocked or admitted at a
// fabricated count. Expiry returns the account to unknown quota until the next
// report re-establishes the window; recovery then follows the normal reactive
// path (429 -> cooldown -> probe -> restore).
export function normalizeQuotaWindow(account: Tier1AccountRuntime, now: number): void {
  if (account.quotaResetAt > 0 && account.quotaResetAt <= now) {
    account.quotaResetAt = 0;
    account.quotaState = 'normal';
    account.quotaRemainingRequests = null;
    account.quotaRemainingTokens = null;
  }
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

/** Record a provider-reported quota window. This is the production writer that
 *  keeps the near_limit diagnostic classification and exhausted_until
 *  eligibility gate. Absolute remaining (requests/tokens) drives reservations;
 *  the ratio (remaining/limit, when the provider reports a ceiling) is
 *  diagnostic only while a free key can still accept work. A `null` report
 *  (unknown quota) remains a no-op pass-through. */
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
  } else if (account.quotaResetAt <= now && (signal.remainingRequests === 0 || signal.remainingTokens === 0)) {
    // Only forget a reset instant that is already in the past. A report without
    // a reset marker must not erase a reset instant a previous report proved,
    // or the exhausted gate and its Retry-After would be lost while the
    // window is still closed.
    account.quotaResetAt = 0;
  }
  if (typeof signal.source === 'string' && signal.source) account.quotaSource = signal.source;

  const remaining = signal.remainingRequests ?? signal.remainingTokens;
  if (remaining === undefined) return true;
  // Classify on the WORSE of the reported tails. A key whose token window is
  // spent is not healthy even when its request window still has room, and the
  // other way round; a single tail must never hide the exhausted one.
  const tails = [quotaTailRatio(signal.remainingRequests, signal.limitRequests), quotaTailRatio(signal.remainingTokens, signal.limitTokens)].filter(
    (tail): tail is number => tail !== null,
  );
  if (tails.length === 0) return true;
  const worstTail = Math.min(...tails);
  const exhausted = tails.some((tail) => tail === 0);
  // Classification semantics match the ratio writer exactly: zero remaining
  // with a known reset is exhausted; a zero-or-tiny tail is near_limit even
  // without a reset marker; otherwise normal.
  if (exhausted && account.quotaResetAt > now) {
    account.quotaState = 'exhausted_until';
  } else if (exhausted || worstTail <= 0.1) {
    account.quotaState = 'near_limit';
    // A zero tail without a reset marker cannot prove when the window
    // refills. Drop the hard reservation gate: pinning it at zero would
    // deny admission forever. The near_limit state is diagnostic only.
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

/**
 * Ratio of a reported quota tail against its ceiling. A tail without a
 * ceiling is absolute: zero is exhausted, one or less is a near-limit tail,
 * anything larger counts as healthy.
 */
function quotaTailRatio(remaining: number | undefined, limit: number | undefined): number | null {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) return remaining / limit;
  if (remaining <= 0) return 0;
  if (remaining <= 1) return 0.1;
  return 1;
}
