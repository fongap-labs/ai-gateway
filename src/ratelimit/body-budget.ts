// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Isolate-wide budget for request bodies in flight. While a request is being
// prepared it holds its body as text, as parsed JSON and as the outbound copy:
// measured live memory is about 2-3x the body. A Worker isolate has about 128 MB,
// so a few concurrent large bodies can exceed it, and the isolate is then killed
// together with every request and stream it serves and all learned Tier 1 state.
//
// The legacy API continues to reserve the declared body or worst-case amount.
// The Gateway now uses an incrementally metered reservation: unknown-length
// bodies initially reserve a small allowance, then must grow the shared charge
// before preflight buffers each chunk. This prevents the old 20 MB placeholder
// and 512 KB cutoff from rejecting normal Code requests while retaining the
// shared per-isolate 32 MB budget. A denied growth returns a retryable 503.

import { createBodyAdmissionPool } from '../../packages/transport/body-admission.ts';

export { BODY_BYTES_IN_FLIGHT_BUDGET } from '../../packages/transport/body-admission.ts';

const gatewayBodyPool = createBodyAdmissionPool();

/** Reserve a request body from the Gateway-owned isolate budget. */
export function admitRequestBody(declaredBytes: number, worstCaseBytes: number): (() => void) | null {
  return gatewayBodyPool.admit(declaredBytes, worstCaseBytes);
}

/** The preflight reader grows this reservation using observed UTF-8 bytes. */
export function admitMeteredRequestBody(
  declaredBytes: number,
  hasBody: boolean,
): { observe: (actualBytes: number) => boolean; release: () => void } | null {
  return gatewayBodyPool.admitGrowing(declaredBytes, hasBody);
}

export function __resetBodyBudgetForTests(): void {
  gatewayBodyPool.reset();
}
