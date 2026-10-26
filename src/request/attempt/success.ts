// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Part of src/request/attempt.ts (behavior-preserving split); see
// attempt/index.ts for the module map.

// success.ts - thin success-finalization dispatcher. Streaming success owns
// first-event commit + stream wiring; object success owns complete-object
// assembly / conversion / synthesis. Keep protocol-specific behavior visible
// in those modules rather than rebuilding a generic result engine here.

import { commitTier1RecoveryProbe } from '../../reliability/tier1-state.ts';
import type { AttemptContext, AttemptOutcome } from '../../types/request.ts';
import { handleMatrixSuccess, isMatrixConversion } from './success-matrix.ts';
import { handleObjectSuccess } from './success-object.ts';
import { handleStreamingSuccess } from './success-stream.ts';

export type SuccessArgs = {
  upstream: Response;
  c: AttemptContext;
  targetUrl: string;
  latencyMs: number;
  detach: () => void;
  upstreamWasStreaming: boolean;
  attemptStartMs?: number;
};

export async function handleSuccess(s: SuccessArgs): Promise<AttemptOutcome> {
  if (isMatrixConversion(s.c.conversionContext)) {
    return handleMatrixSuccess(s);
  }
  if (s.c.clientWantsStream && s.upstreamWasStreaming) {
    return handleStreamingSuccess(s);
  }
  // Buffered reply already past upstream.ok (the caller validates status):
  // those response headers are the earliest recovery-probe evidence, so the
  // v2 gate commits here — before any body parsing — and other requests stop
  // waiting on the probe. Streaming (native) commits at its first SSE event
  // inside handleStreamingSuccess; matrix paths commit inside their own
  // handler. All commits are no-ops under the legacy gate.
  if (s.c.node.tier === 'tier-1') {
    commitTier1RecoveryProbe(s.c.node.id, s.c.state?.requestedModel ?? s.c.requestedModel);
  }
  return handleObjectSuccess(s);
}
