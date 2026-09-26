// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// RuntimeStateStore projections — the single read surface over the two
// runtime-state backends. The Tier 1 adaptive runtime and the Tier 2/3 node
// state keep their own implementations and learning signals; this module only
// projects their existing state onto the unified contracts in
// types/runtime-state.ts. Upper layers read state through these projections
// instead of importing backend internals.
//
// Read-only by contract: claims, releases, outcome recording, and quota
// settlement stay in tier1-state.ts / node-state.ts and the dispatch funnels.
// A field a backend does not track is null, never a fabricated value: the
// Tier 1 runtime learns TTFT/failure/circuit state per (account, model) and
// has no numeric health score or endpoint-level circuit; Tier 2/3 node state
// has no per-account auth/quota concept.

import type {
  RuntimeStateStore, EndpointState, AccountState, ModelState, QuotaRuntimeState,
} from '../types/runtime-state.ts';
import type { RuntimeNode } from '../types/node.ts';
import {
  getTier1Account, getTier1ModelPerf, tier1QuotaState,
} from './tier1-state.ts';
import {
  peekAvailability, getNodeState, getCooldownRemainingMs, getModelCooldownRemainingMs, getModelPerf,
} from './node-state.ts';

function remainingMs(until: number, now: number): number {
  return until > now ? until - now : 0;
}

const UNKNOWN_QUOTA: QuotaRuntimeState = Object.freeze({
  state: 'unknown', resetAtMs: 0, remainingRequests: null, remainingTokens: null, source: null,
});

// ---- Tier 1 adaptive runtime projection --------------------------------------

const TIER1_QUOTA_STATE = Object.freeze({
  normal: 'healthy',
  near_limit: 'near_limit',
  exhausted_until: 'exhausted',
} as const);

const tier1QuotaOf = (accountId: string, now: number): QuotaRuntimeState => {
  const account = getTier1Account(accountId);
  // Window-expiry normalization is claim-time work; the read projection mirrors
  // it so a rolled window surfaces as unknown without waiting for a claim.
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
    // Tier 1 circuit state lives at (account, model) scope; the endpoint
    // projection does not invent an account-level circuit.
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

// ---- Tier 2/3 node-state projection ------------------------------------------

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
  // Tier 2/3 nodes ARE the account identity: auth-disable and quota windows
  // are not tracked per-account there, so they surface as neutral defaults.
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

/** Resolve the runtime-state store for a runtime node's tier. This is the one
 *  dispatcher upper layers use to read state without knowing backends. */
export function runtimeStateStoreFor(node: Pick<RuntimeNode, 'tier'>): RuntimeStateStore {
  return node.tier === 'tier-1' ? tier1RuntimeStateStore : nodeRuntimeStateStore;
}
