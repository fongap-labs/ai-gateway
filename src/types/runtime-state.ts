export type RuntimeAvailability = 'available' | 'cooling' | 'probing' | 'unavailable';

export type EndpointState = Readonly<{
  availability: RuntimeAvailability;
  inFlight: number;
  cooldownRemainingMs: number;
  cooldownReason: string | null;
  circuit: 'closed' | 'half_open' | 'open' | null;
  health: number | null;
  ttftEwmaMs: number | null;
  latencyEwmaMs: number | null;
  lastUsedAt: number;
}>;

export type ModelState = Readonly<{
  supported: boolean;
  cooldownRemainingMs: number;
  failureState: string;
  ttftEwmaMs: number | null;
  latencyEwmaMs: number | null;
  sampleCount: number;
}>;

export type QuotaRuntimeState = Readonly<{
  state: 'unknown' | 'healthy' | 'near_limit' | 'exhausted';
  resetAtMs: number;
  remainingRequests: number | null;
  remainingTokens: number | null;
  source: string | null;
}>;

export type AccountState = Readonly<{
  disabled: boolean;
  cooldownRemainingMs: number;
  quota: QuotaRuntimeState;
  inFlight: number;
}>;

export interface RuntimeStateStore {
  endpoint(nodeId: string, now?: number): EndpointState;
  account(nodeId: string, now?: number): AccountState;
  model(nodeId: string, modelId: string, now?: number): ModelState | null;
}
