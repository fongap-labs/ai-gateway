// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Isolate-wide budget for request bodies in flight. While a request is being
// prepared it holds its body as text, as parsed JSON and as the outbound copy:
// measured live memory is about 2-3x the body. A Worker isolate has about 128 MB,
// so a few concurrent large bodies can exceed it, and the isolate is then killed
// together with every request and stream it serves and all learned Tier 1 state.
//
// The budget charges each request its declared Content-Length. A request with no
// usable Content-Length (missing, non-numeric, or <= 0) is charged the worst case,
// the configured maximum body size, because chunked transfer can carry any size.
// Without this, chunked uploads would bypass the budget entirely. A request that
// would push the total past BODY_BYTES_IN_FLIGHT_BUDGET is refused with a retryable
// 503, except when nothing else is in flight, so one body up to
// AIG_REQUEST_BODY_MAX_BYTES always fits. The release function returns the charged
// amount, so an over-estimate is refunded in full.

import { createBodyAdmissionPool } from '../../packages/transport/body-admission.ts';
export { BODY_BYTES_IN_FLIGHT_BUDGET } from '../../packages/transport/body-admission.ts';

const gatewayBodyPool = createBodyAdmissionPool();

/** Reserve a request body from the Gateway-owned isolate budget. */
export function admitRequestBody(declaredBytes: number, worstCaseBytes: number): (() => void) | null {
  return gatewayBodyPool.admit(declaredBytes, worstCaseBytes);
}

export function __resetBodyBudgetForTests(): void {
  gatewayBodyPool.reset();
}
