// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Isolate-local retry budget. Rotating to another key after a 429, a refusal or a
// missing model is ordinary pool behaviour and is not limited here. What this
// bounds is the speculative, expensive work that follows an upstream that is slow
// or failing (timeouts, 5xx, dropped connections, empty replies) and the hedge
// twins: when many requests are in that state at once, they would otherwise all
// walk the whole key pool and push the healthy keys into rate limits.
//
// A request holds at most one retry slot, from its first speculative retry until
// the request leaves the pre-commit phase. The number of requests allowed to hold
// one at the same moment is RETRY_BUDGET_RATIO of the requests being served, but
// never fewer than RETRY_BUDGET_MIN, so a small private deployment is never shed.
// Like all Tier 1 state it is best effort and per isolate.

import { type FailureKind, KIND } from './classify.ts';

export const RETRY_BUDGET_RATIO = 0.2;
export const RETRY_BUDGET_MIN = 3;

let activeRequests = 0;
let retryingRequests = 0;
let deniedTotal = 0;

// Failures after which another attempt is speculative. A pool rotation after a
// 429, an auth refusal, a client error or a missing model is not in this set.
const SPECULATIVE_RETRY_AFTER: ReadonlySet<FailureKind> = new Set([
  KIND.SERVER,
  KIND.NETWORK,
  KIND.HEADERS_TIMEOUT,
  KIND.FIRST_EVENT_TIMEOUT,
  KIND.STREAM_INTERRUPTED,
  KIND.NON_JSON_BODY,
  KIND.EMPTY_200,
]);

export function isSpeculativeRetryAfter(kind: unknown): boolean {
  return typeof kind === 'string' && SPECULATIVE_RETRY_AFTER.has(kind as FailureKind);
}

export class RetrySlot {
  private isHeld = false;
  private isEnded = false;

  constructor() {
    activeRequests++;
  }

  /** True when this request may spend a speculative retry or hedge. Idempotent. */
  tryAcquire(): boolean {
    if (this.isEnded) return false;
    if (this.isHeld) return true;
    if (retryingRequests >= Math.max(RETRY_BUDGET_MIN, Math.ceil(activeRequests * RETRY_BUDGET_RATIO))) {
      deniedTotal++;
      return false;
    }
    retryingRequests++;
    this.isHeld = true;
    return true;
  }

  /** Called when the request stops being able to retry (response chosen or failed). */
  end(): void {
    if (this.isEnded) return;
    this.isEnded = true;
    activeRequests = Math.max(0, activeRequests - 1);
    if (this.isHeld) retryingRequests = Math.max(0, retryingRequests - 1);
  }
}

export function snapshotRetryBudget(): { active: number; retrying: number; denied: number } {
  return { active: activeRequests, retrying: retryingRequests, denied: deniedTotal };
}

export function __resetRetryBudgetForTests(): void {
  activeRequests = 0;
  retryingRequests = 0;
  deniedTotal = 0;
}
