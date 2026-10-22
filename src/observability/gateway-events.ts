// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Cross-isolate attempt events. Isolate-local stats only show the isolate that
// answers /metrics, so per-key utilization, 429 frequency and retry/hedge
// amplification are written as one Workers Analytics Engine data point per
// physical upstream call. The GATEWAY_EVENTS binding is optional (deploy adds it
// when AIG_ANALYTICS_DATASET is set); without it, or when a write throws, nothing
// happens. Events are observation only and never feed routing.
//
// Data point layout (query by position in the Analytics Engine SQL API):
//   index1   node id (sampling key)
//   blob1-7  node id, provider, tier, logical model, outcome, role, route
//   double1-4 HTTP status (0 when none), headers ms, first output ms, attempt ms (-1 when unknown)

import type { GatewayEnv } from '../types/runtime.ts';

export type AttemptRole = 'primary' | 'hedge' | 'retry';

export type AttemptEvent = {
  nodeId: string;
  provider: string;
  tier: string;
  model: string;
  outcome: string;
  role: AttemptRole;
  route: string;
  status: number;
  headersMs: number;
  ttftMs: number;
  latencyMs: number;
};

type AnalyticsDataset = { writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void };

function datasetOf(env: GatewayEnv): AnalyticsDataset | null {
  const dataset = env?.GATEWAY_EVENTS as Partial<AnalyticsDataset> | null | undefined;
  return dataset && typeof dataset.writeDataPoint === 'function' ? (dataset as AnalyticsDataset) : null;
}

export function recordAttemptEvent(env: GatewayEnv, event: AttemptEvent): void {
  const dataset = datasetOf(env);
  if (!dataset) return;
  try {
    dataset.writeDataPoint({
      indexes: [event.nodeId],
      blobs: [event.nodeId, event.provider, event.tier, event.model, event.outcome, event.role, event.route],
      doubles: [event.status, event.headersMs, event.ttftMs, event.latencyMs],
    });
  } catch {
    /* observability must never affect a request */
  }
}
