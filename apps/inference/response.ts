// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Inference-private error envelope. Never include raw upstream payloads or tokens.
export function problem(status: number, code: string, isRetryable = false): Response {
  return new Response(JSON.stringify({ error: { code, retryable: isRetryable } }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-aig-error-kind': code,
      'x-aig-retryable': String(isRetryable),
    },
  });
}
