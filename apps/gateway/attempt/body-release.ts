// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { AttemptContext } from '../../../src/types/request.ts';

export const LARGE_BODY_CHARS = 1024 * 1024;

export function releaseLargeRequestBody(c: AttemptContext): void {
  if ((c.reqDescriptor.bodyChars ?? 0) <= LARGE_BODY_CHARS) return;
  c.bodyJson = {};
  c.rawBody = undefined;
  c.conversionContext = null;
}
