// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Isolate-wide budget for request bodies in flight. While a request is being
// prepared it holds its body as text, as parsed JSON and as the outbound copy:
// measured live memory is about 2-3x the body. A Worker isolate has about 128 MB,
// so a few concurrent large bodies can exceed it, and the isolate is then killed
// together with every request and stream it serves and all learned Tier 1 state.
//
// The budget counts declared Content-Length. A request that would push the total
// past BODY_BYTES_IN_FLIGHT_BUDGET is refused with a retryable 503, except when
// nothing else is in flight, so one body up to AIG_REQUEST_BODY_MAX_BYTES always
// fits. A body sent without Content-Length is not counted.

export const BODY_BYTES_IN_FLIGHT_BUDGET = 32 * 1024 * 1024;

let inFlightBytes = 0;

/** Reserve `declaredBytes`; returns the release function, or null when over budget. */
export function admitRequestBody(declaredBytes: number): (() => void) | null {
  const bytes = Number.isFinite(declaredBytes) && declaredBytes > 0 ? Math.trunc(declaredBytes) : 0;
  if (bytes > 0 && inFlightBytes > 0 && inFlightBytes + bytes > BODY_BYTES_IN_FLIGHT_BUDGET) return null;
  inFlightBytes += bytes;
  let isReleased = false;
  return () => {
    if (isReleased) return;
    isReleased = true;
    inFlightBytes = Math.max(0, inFlightBytes - bytes);
  };
}

export function __resetBodyBudgetForTests(): void {
  inFlightBytes = 0;
}
