// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Generation-private errors preserve the dispatched/attempted distinction.
export function problem(status: number, code: string, result = 'not-dispatched'): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-aig-error-kind': code,
      'x-aig-result': result,
    },
  });
}
