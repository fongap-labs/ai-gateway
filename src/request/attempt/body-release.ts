// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Part of src/request/attempt.ts (behavior-preserving split); see
// attempt/index.ts for the module map.

// body-release.ts - drops large request-body references once a streaming
// response is committed. The parsed body is no longer needed by the stream
// callbacks, and retaining it for the whole stream keeps a large prompt tree
// alive beside the response.

import type { AttemptContext } from '../../types/request.ts';

// Matches the hedge cutoff: bodies above this size are never hedged, so the
// parsed tree and raw text can be released as soon as streaming is committed.
export const LARGE_BODY_CHARS = 1024 * 1024;

export function releaseLargeRequestBody(c: AttemptContext): void {
  if ((c.reqDescriptor.bodyChars ?? 0) <= LARGE_BODY_CHARS) return;
  c.bodyJson = {};
  c.rawBody = undefined;
}
