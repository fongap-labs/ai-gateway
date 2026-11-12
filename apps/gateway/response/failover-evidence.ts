// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// A successful reply is evidence of failover only if a previous upstream
// dispatch actually failed. Pre-dispatch skips and hedges cancelled after
// another request won are not provider failures.
import { KIND } from '../../../src/reliability/classify.ts';

const NON_FAILURE_KINDS: ReadonlySet<string> = new Set([KIND.CLIENT_ABORT, KIND.CANCELLED_AFTER_PEER_COMMIT]);

export function hasConfirmedUpstreamFailure(attempts: ReadonlyArray<Record<string, unknown>>): boolean {
  return attempts.some((attempt) => {
    if (attempt.dispatched !== true || typeof attempt.kind !== 'string') return false;
    if (NON_FAILURE_KINDS.has(attempt.kind)) return false;
    // Only a classified failure proves recovery. A successful hedged
    // dispatch or an unclassified event must never set the failover flag.
    return Object.values(KIND).some((kind) => kind === attempt.kind);
  });
}
