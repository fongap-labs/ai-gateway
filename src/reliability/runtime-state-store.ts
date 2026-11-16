import type { RuntimeNode } from '../types/node.ts';
import type { EndpointState, QuotaRuntimeState, RuntimeStateStore } from '../types/runtime-state.ts';
import { getCooldownRemainingMs, getModelCooldownRemainingMs, getModelPerf, getNodeState, peekAvailability } from './node-state.ts';
import { getTier1Account, getTier1ModelPerf, tier1QuotaState } from './tier1-state.ts';

function remainingMs(until: number, now: number): number {
  return until > now ? until - now : 0;
}

const UNKNOWN_QUOTA: QuotaRuntimeState = Object.freeze({
  state: 'unknown',
  resetAtMs: 0,
  remainingRequests: null,
  remainingTokens: null,
  source: null,
});

const TIER1_QUOTA_STATE = Object.freeze({
  normal: 'healthy',
  near_limit: 'near_limit',
  exhausted_until: 'exhausted',
} as const);

const tier1QuotaOf = (accountId: string, now: number): QuotaRuntimeState => {
  const account = getTier1Account(accountId);
  if (account.quotaResetAt > 0 && account.quotaResetAt <= now) {
    return UNKNOWN_QUOTA;
  }
  const state = tier1QuotaState(accountId, now);
  if (account.quotaRemainingRequests === null && account.quotaRemainingTokens === null && state === 'normal') {
    return UNKNOWN_QUOTA;
  }
  return {
    state: TIER1_QUOTA_STATE[state],
    resetAtMs: account.quotaResetAt > now ? account.quotaResetAt : 0,
    remainingRequests: account.quotaRemainingRequests,
    remainingTokens: account.quotaRemainingTokens,
    source: account.quotaSource,
  };
};

const tier1Endpoint = (accountId: string, now: number): EndpointState => {
  const account = getTier1Account(accountId);
  const cooldownRemainingMs = remainingMs(account.accountCooldownUntil, now);
  return {
    availability: account.accountDisabled ? 'unavailable' : cooldownRemainingMs > 0 ? 'cooling' : 'available',
    inFlight: account.inFlight,
    cooldownRemainingMs,
    cooldownReason: cooldownRemainingMs > 0 ? account.accountCooldownReason : null,
    circuit: null,
    health: null,
    ttftEwmaMs: null,
    latencyEwmaMs: null,
    lastUsedAt: 0,
  };
};

export const tier1RuntimeStateStore: RuntimeStateStore = {
  endpoint: (accountId, now = Date.now()) => tier1Endpoint(accountId, now),
  account: (accountId, now = Date.now()) => {
    const account = getTier1Account(accountId);
    return {
      disabled: account.accountDisabled,
      cooldownRemainingMs: remainingMs(account.accountCooldownUntil, now),
      quota: tier1QuotaOf(accountId, now),
      inFlight: account.inFlight,
    };
  },
  model: (accountId, modelId, now = Date.now()) => {
    const model = getTier1ModelPerf(accountId, modelId);
    if (!model) return null;
    return {
      supported: model.supported,
      cooldownRemainingMs: remainingMs(model.cooldownUntil, now),
      failureState: model.failureState,
      ttftEwmaMs: model.ttftEwma,
      latencyEwmaMs: null,
      sampleCount: model.sampleCount,
    };
  },
};

const NODE_AVAILABILITY = Object.freeze({
  yes: 'available',
  probe: 'probing',
  no: 'unavailable',
} as const);

export const nodeRuntimeStateStore: RuntimeStateStore = {
  endpoint: (nodeId, now = Date.now()) => {
    const s = getNodeState(nodeId);
    return {
      availability: NODE_AVAILABILITY[peekAvailability(nodeId, now)],
      inFlight: s.activeRequests,
      cooldownRemainingMs: getCooldownRemainingMs(nodeId, now),
      cooldownReason: s.cooldownUntil > now ? s.cooldownReason : null,
      circuit: s.circuitState === 'half-open' ? 'half_open' : s.circuitState,
      health: s.healthScore,
      ttftEwmaMs: s.avgTtftMs > 0 ? s.avgTtftMs : null,
      latencyEwmaMs: s.avgLatencyMs > 0 ? s.avgLatencyMs : null,
      lastUsedAt: s.lastUsedAt,
    };
  },
  account: (nodeId, now = Date.now()) => ({
    disabled: false,
    cooldownRemainingMs: getCooldownRemainingMs(nodeId, now),
    quota: UNKNOWN_QUOTA,
    inFlight: getNodeState(nodeId).activeRequests,
  }),
  model: (nodeId, modelId, now = Date.now()) => {
    const perf = getModelPerf(nodeId, modelId);
    const cooling = getModelCooldownRemainingMs(nodeId, modelId, now);
    if (!perf && cooling === 0) return null;
    return {
      supported: cooling === 0,
      cooldownRemainingMs: cooling,
      failureState: cooling > 0 ? 'cooldown' : 'normal',
      ttftEwmaMs: perf && perf.avgTtftMs > 0 ? perf.avgTtftMs : null,
      latencyEwmaMs: perf && perf.avgLatencyMs > 0 ? perf.avgLatencyMs : null,
      sampleCount: perf ? perf.ttftSamples : 0,
    };
  },
};

export function runtimeStateStoreFor(node: Pick<RuntimeNode, 'tier'>): RuntimeStateStore {
  return node.tier === 'tier-1' ? tier1RuntimeStateStore : nodeRuntimeStateStore;
}
