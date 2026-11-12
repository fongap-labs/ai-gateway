// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Thin wrapper around Cloudflare's native custom-span API. Absent tracing
// context (Node tests, local adapters, disabled platform tracing) is a no-op.
// Never emit bodies, credentials, raw URLs or upstream response details.

import type { ExecutionContextLike, GatewayTraceSpan } from './runtime.ts';

export type SpanTags = {
  requestId: string;
  nodeId?: string;
  model?: string;
  center?: 'gateway' | 'inference' | 'perception' | 'generation';
  phase?: string;
};

export async function withNativeSpan<T>(
  ctx: ExecutionContextLike | undefined,
  name: string,
  tags: SpanTags,
  action: () => Promise<T>,
  annotate?: (span: GatewayTraceSpan, result: T) => void,
): Promise<T> {
  const tracing = ctx?.tracing;
  if (!tracing) return action();
  return tracing.enterSpan(name, async (span) => {
    if (span.isTraced !== false) {
      span.setAttribute('aig.request_id', tags.requestId.slice(0, 36));
      if (tags.nodeId) span.setAttribute('aig.node_id', tags.nodeId.slice(0, 96));
      if (tags.model) span.setAttribute('aig.model', tags.model.slice(0, 96));
      if (tags.center) span.setAttribute('aig.center', tags.center);
      if (tags.phase) span.setAttribute('aig.phase', tags.phase.slice(0, 48));
    }
    const result = await action();
    if (span.isTraced !== false) {
      if (result instanceof Response) span.setAttribute('http.response.status_code', result.status);
      annotate?.(span, result);
    }
    return result;
  });
}
