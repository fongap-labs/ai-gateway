// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Isolate-local observation of active request handlers. This is NOT an
// admission gate. A configured request-count limit must never turn the ninth
// healthy request into HTTP 503; request-body byte admission remains separate.
//
// Observe the execution phase only; after Gateway returns response headers,
// existing stream metrics own the downstream streaming lifecycle. Do not wrap
// an SSE Response merely to count an active connection.

let activeHandlers = 0;
let peakHandlers = 0;
let startedTotal = 0;
let completedTotal = 0;

export function trackIsolateRequest(): () => void {
  activeHandlers++;
  startedTotal++;
  peakHandlers = Math.max(peakHandlers, activeHandlers);
  let isReleased = false;
  return () => {
    if (isReleased) return;
    isReleased = true;
    activeHandlers = Math.max(0, activeHandlers - 1);
    completedTotal++;
  };
}

export function snapshotIsolateRequestActivity(): {
  active: number;
  peak: number;
  started: number;
  completed: number;
} {
  return { active: activeHandlers, peak: peakHandlers, started: startedTotal, completed: completedTotal };
}

export function __resetIsolateConcurrencyForTests(): void {
  activeHandlers = 0;
  peakHandlers = 0;
  startedTotal = 0;
  completedTotal = 0;
}
