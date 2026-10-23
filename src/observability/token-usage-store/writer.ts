// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Token Usage Writer.
//
// Two accounting views intentionally coexist in the SAME aggregate tables:
//
//   delivered columns  — one successfully delivered response; these keep the
//                        established model-status / TTFT evidence semantics.
//   upstream_* columns — one real physical upstream dispatch, including failed
//                        fallback/retry/hedge work. Tokens are counted only
//                        when the upstream actually reports usage; missing
//                        reports are counted and NEVER estimated.
//
// A successfully delivered response is also one physical upstream attempt, so
// persistTokenUsage() updates both views in the same merged upsert. Non-delivered
// physical attempts use persistUpstreamAttemptUsage(), which touches only
// upstream_* columns and therefore cannot fabricate success evidence in
// `requests` / `usage_reports` / TTFT histograms.
//
// Both entry points go through the isolate-local write buffer (buffer.ts). The
// SQL lives in statements.ts. A caller's promise settles when the event's flush
// has been written, and events that do not trigger a flush resolve immediately.

import type { GatewayEnv } from '../../types/runtime.ts';
import { normalizeUsageReport } from '../token-usage.ts';
import { bufferPersist } from './buffer.ts';
import type { UsagePayload } from './statements.ts';

export function tokenUsagePayload(usage: unknown): UsagePayload {
  const report = normalizeUsageReport(usage);
  if (report) {
    const normalized = report.usage;
    return {
      input: normalized.input,
      output: normalized.output,
      cacheCreation: normalized.cacheCreation,
      cacheRead: normalized.cacheRead,
      effectiveInput: normalized.effectiveInput,
      observedCacheRead: report.observedCacheRead,
      observedCacheInput: report.observedCacheInput,
      cacheReadReports: report.hasCacheRead ? 1 : 0,
      total: normalized.total,
      requests: 1,
      reports: 1,
      missing: 0,
    };
  }
  return {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    effectiveInput: 0,
    observedCacheRead: 0,
    observedCacheInput: 0,
    cacheReadReports: 0,
    total: 0,
    requests: 1,
    reports: 0,
    missing: 1,
  };
}

// Buffer one SUCCESSFULLY DELIVERED response. The buffer applies the delivered
// columns, the TTFT histogram (when a model is given) and the upstream columns.
export function persistTokenUsage(
  env: GatewayEnv,
  usage: unknown,
  now: number = Date.now(),
  model: string | null = null,
  ttftMs: number | null = null,
): Promise<void> {
  return bufferPersist(env, 'delivered', { now, model, usage: tokenUsagePayload(usage), ttftMs });
}

// Buffer one physical upstream attempt that did NOT become the delivered
// response (failure, retry/fallback loss, hedge loser, or client-cancelled live
// upstream). It touches upstream_* columns only.
export function persistUpstreamAttemptUsage(env: GatewayEnv, usage: unknown, now: number = Date.now(), model: string | null = null): Promise<void> {
  return bufferPersist(env, 'upstream', { now, model, usage: tokenUsagePayload(usage) });
}
