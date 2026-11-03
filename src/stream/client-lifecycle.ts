// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Internal marker stripped before returning the response to clients.
export const SYNTHETIC_CLIENT_STREAM_HEADER = 'x-gateway-internal-synthetic-stream';

export function markSyntheticClientStreamHeaders(headers?: Record<string, string>): Record<string, string> {
  return {
    ...(headers || {}),
    [SYNTHETIC_CLIENT_STREAM_HEADER]: '1',
  };
}
