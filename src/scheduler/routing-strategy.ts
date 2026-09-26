// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Routing strategy contract.
//
// One tier selects one eligible node through one strategy. The strategy owns
// the ranking algorithm and the admission claim; it does not own reliability
// state, failure classification, or fallback policy. Adding a new strategy
// is one module plus one registry line — the request tier loop resolves
// strategy by tier and never branches on the algorithm itself.
//
// Current mapping (production behavior, unchanged):
//   tier-1 -> p2c_ttft          (Tier 1 P2C + passive TTFT + affinity + heat)
//   tier-2 -> priority_lru      (current Tier 2/3 health/latency selection)
//   tier-3 -> priority_lru
//
// Future strategies (cost / quality / learned) are deliberately NOT
// implemented without a concrete need; the contract is the extension point.

import { pickTier1Candidate } from './tier1-scheduler.ts';
import { pickCandidate } from './scheduler.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { Tier, PickedCandidate, RoutableRequest } from '../types/scheduler.ts';

export type RoutingStrategyId = 'p2c_ttft' | 'priority_lru';

/** Unified pick options. A strategy reads the fields it needs; fields it does
 *  not own are ignored. `excludeIds`/`raceLostIds` are alternative names for
 *  the same set of nodes to skip after a same-tier admission race loss. */
export type RoutingPickOptions = {
  now?: number,
  rng?: () => number,
  knownModels?: ReadonlySet<string> | null,
  affinityAccountId?: string | null,
  evaluateAffinity?: boolean,
  excludeId?: string | null,
  excludeIds?: ReadonlySet<string> | null,
  raceLostIds?: Set<string> | null,
  maxInFlight?: number | null,
};

export interface RoutingStrategy {
  readonly id: RoutingStrategyId;
  pick(
    tierNodes: ReadonlyArray<RuntimeNode>,
    req: RoutableRequest,
    attempted: Set<string>,
    opts: RoutingPickOptions,
  ): PickedCandidate | null;
}

/** Tier 1: power-of-two-choices with passive TTFT, soft affinity, provider-model
 *  heat, and the quota/reservation admission gate. Delegates to
 *  pickTier1Candidate unchanged. */
export const p2cTtftStrategy: RoutingStrategy = {
  id: 'p2c_ttft',
  pick: (tierNodes, req, attempted, opts) => pickTier1Candidate(tierNodes, req, attempted, opts),
};

/** Tier 2/3: current health/latency/availability single-best selection. Delegates
 *  to pickCandidate unchanged. */
export const priorityLruStrategy: RoutingStrategy = {
  id: 'priority_lru',
  pick: (tierNodes, req, attempted, opts) =>
    pickCandidate(tierNodes, req, attempted, opts.now, opts.excludeId ?? null, opts.knownModels ?? null, opts.excludeIds ?? opts.raceLostIds ?? null),
};

/** Resolve the routing strategy for a tier. This is the one dispatcher the
 *  request tier loop uses; it never branches on the algorithm by tier. */
export function routingStrategyFor(tier: Tier): RoutingStrategy {
  return tier === 1 ? p2cTtftStrategy : priorityLruStrategy;
}
