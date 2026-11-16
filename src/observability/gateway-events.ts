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
  } catch {}
}
