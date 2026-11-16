// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { RuntimeNode } from '../types/node.ts';
import type { PickedCandidate, RoutableRequest, Tier } from '../types/scheduler.ts';
import { pickCandidate } from './scheduler.ts';
import { pickTier1Candidate } from './tier1-scheduler.ts';

export type RoutingStrategyId = 'p2c_ttft' | 'priority_lru';

export type RoutingPickOptions = {
  now?: number;
  rng?: () => number;
  knownModels?: ReadonlySet<string> | null;
  affinityAccountId?: string | null;
  evaluateAffinity?: boolean;
  excludeId?: string | null;
  excludeIds?: ReadonlySet<string> | null;
  raceLostIds?: Set<string> | null;
  maxInFlight?: number | null;
};

export interface RoutingStrategy {
  readonly id: RoutingStrategyId;
  pick(tierNodes: ReadonlyArray<RuntimeNode>, req: RoutableRequest, attempted: Set<string>, opts: RoutingPickOptions): PickedCandidate | null;
}

export const p2cTtftStrategy: RoutingStrategy = {
  id: 'p2c_ttft',
  pick: (tierNodes, req, attempted, opts) => pickTier1Candidate(tierNodes, req, attempted, opts),
};

export const priorityLruStrategy: RoutingStrategy = {
  id: 'priority_lru',
  pick: (tierNodes, req, attempted, opts) =>
    pickCandidate(tierNodes, req, attempted, opts.now, opts.excludeId ?? null, opts.knownModels ?? null, opts.excludeIds ?? opts.raceLostIds ?? null),
};

export function routingStrategyFor(tier: Tier): RoutingStrategy {
  return tier === 1 ? p2cTtftStrategy : priorityLruStrategy;
}
