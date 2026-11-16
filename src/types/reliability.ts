export type ModelPerfEntry = {
  avgTtftMs: number;
  avgLatencyMs: number;
  lastUsedAt: number;
  ttftSamples: number;
  passiveSamples: number;
  probeSamples: number;
  lastTtftAt: number;
  lastProbeFailureAt: number;
};

export type CircuitState = 'closed' | 'open' | 'half-open';

export type NodeState = {
  activeRequests: number;
  healthScore: number;
  avgLatencyMs: number;
  avgTtftMs: number;
  cooldownUntil: number;
  cooldownReason: string | null;
  circuitState: CircuitState;
  consecutiveFailures: number;
  lastTransientFailureAt: number;
  probeInFlight: boolean;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastUsedAt: number;
  modelCooldowns: Map<string, number>;
  modelPerf: Map<string, ModelPerfEntry>;
};
