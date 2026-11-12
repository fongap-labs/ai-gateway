// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// A physical Provider adapter receives only approved protocol headers from
// the private execution ticket. Never forward end-user or center credentials.
export function buildProviderForwardRequest(request: Request): Request {
  const headers = new Headers();
  for (const name of ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'idempotency-key']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Request('https://inference.internal/execute', { method: 'POST', headers });
}
