// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Internal W3C Trace Context propagation. Trace IDs are derived from the
// Gateway-generated request UUID, never from an untrusted client header.
// Until a sampler/exporter is installed, the sampled flag remains unset.

export type TraceContext = { traceId: string; spanId: string; flags: string };

export function traceIdForRequest(requestId: string): string | null {
  const id = requestId.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) && !/^0{32}$/.test(id) ? id : null;
}

export function parseTraceparent(value: string | null): TraceContext | null {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value ?? '');
  if (!match || /^0{32}$/.test(match[1]) || /^0{16}$/.test(match[2])) return null;
  return { traceId: match[1], spanId: match[2], flags: match[3] };
}

function freshSpanId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/** One independent child of the Gateway request per preflight or attempt. */
export function createInternalTraceparent(requestId: string): string | null {
  const traceId = traceIdForRequest(requestId);
  return traceId ? `00-${traceId}-${freshSpanId()}-00` : null;
}

/** Only a valid, same-request internal parent may reach the Provider. */
export function childTraceparent(parent: string | null, requestId: string): string | null {
  const parsed = parseTraceparent(parent);
  if (!parsed || parsed.traceId !== traceIdForRequest(requestId)) return null;
  return `00-${parsed.traceId}-${freshSpanId()}-${parsed.flags}`;
}
