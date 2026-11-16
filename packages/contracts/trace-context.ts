export type TraceContext = { traceId: string; spanId: string; flags: string };

export function traceIdForRequest(requestId: string): string | null {
  const id = requestId.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) && !/^0{32}$/.test(id) ? id : null;
}

export function parseTraceparent(value: string | null): TraceContext | null {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value ?? '');
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  if (!traceId || !spanId || !flags || /^0{32}$/.test(traceId) || /^0{16}$/.test(spanId)) return null;
  return { traceId, spanId, flags };
}

function freshSpanId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export function createInternalTraceparent(requestId: string): string | null {
  const traceId = traceIdForRequest(requestId);
  return traceId ? `00-${traceId}-${freshSpanId()}-00` : null;
}

export function childTraceparent(parent: string | null, requestId: string): string | null {
  const parsed = parseTraceparent(parent);
  if (!parsed || parsed.traceId !== traceIdForRequest(requestId)) return null;
  return `00-${parsed.traceId}-${freshSpanId()}-${parsed.flags}`;
}

export function validatedInternalTraceparent(requestId: string, supplied?: string): string | null {
  const parsed = parseTraceparent(supplied ?? null);
  return parsed && parsed.traceId === traceIdForRequest(requestId) ? (supplied ?? null) : createInternalTraceparent(requestId);
}
