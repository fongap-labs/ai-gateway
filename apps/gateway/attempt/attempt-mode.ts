// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { AttemptContext } from '../../../src/types/request.ts';

export function isBufferedUpstreamReply(c: Pick<AttemptContext, 'conversionContext' | 'clientWantsStream' | 'fakeStream'>): boolean {
  return !c.conversionContext && !c.clientWantsStream && !c.fakeStream;
}
