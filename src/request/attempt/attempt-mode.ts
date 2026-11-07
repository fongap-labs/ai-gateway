// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// One shared buffering decision for the legacy transport and original exports.
import type { AttemptContext } from '../../types/request.ts';

/**
 * True when the upstream is asked for one buffered JSON reply. A matrix
 * translation always asks the upstream to stream, and a streaming client or the
 * stream guard (fakeStream) makes the upstream stream as well.
 */
export function isBufferedUpstreamReply(c: Pick<AttemptContext, 'conversionContext' | 'clientWantsStream' | 'fakeStream'>): boolean {
  return !c.conversionContext && !c.clientWantsStream && !c.fakeStream;
}
