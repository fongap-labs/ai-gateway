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

/** Explicitly signal that an OAuth subscription attempt never reached a Provider. */
export function preDispatchProblem(status: number, code: string): Response {
  const response = problem(status, code);
  response.headers.set('x-aig-result', 'skipped');
  return response;
}
