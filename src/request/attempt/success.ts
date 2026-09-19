// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Part of src/request/attempt.ts (behavior-preserving split); see
// attempt/index.ts for the module map.

// success.ts - thin success-finalization dispatcher. Streaming success owns
// first-event commit + stream wiring; object success owns complete-object
// assembly / conversion / synthesis. Keep protocol-specific behavior visible
// in those modules rather than rebuilding a generic result engine here.

import { handleStreamingSuccess } from './success-stream.ts';
import { handleObjectSuccess } from './success-object.ts';
import type { AttemptContext, AttemptOutcome } from '../../types/request.ts';

export type SuccessArgs = {
  upstream: Response,
  c: AttemptContext,
  targetUrl: string,
  latencyMs: number,
  detach: () => void,
  upstreamWasStreaming: boolean,
  attemptStartMs?: number,
};

export async function handleSuccess(s: SuccessArgs): Promise<AttemptOutcome> {
  if (s.c.clientWantsStream && s.upstreamWasStreaming) {
    return handleStreamingSuccess(s);
  }
  return handleObjectSuccess(s);
}
