// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import { tier1CountDispatchableNodes, tier1HasDispatchableNode } from '../../../src/reliability/tier1-state.ts';
import { routingStrategyFor } from '../../../src/scheduler/routing-strategy.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';
import type { PolicyConfig } from '../../../src/types/policy.ts';
import type { RoutableRequest, Tier, TierMap } from '../../../src/types/scheduler.ts';
import { cryptoRng } from '../../../src/utils/crypto-rng.ts';
import { TIER_ORDER } from '../policy/router.ts';
import { countDispatchableNodes, tierHasDispatchableNode } from './scheduler.ts';

function tier1Dispatchable(
  nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number,
  knownModels: ReadonlySet<string>,
  maxInFlight?: number | null,
): boolean {
  return tier1HasDispatchableNode(nodes, req, attempted, now, knownModels, maxInFlight);
}

function tier1LiveCount(
  nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number,
  knownModels: ReadonlySet<string>,
  maxInFlight?: number | null,
): number {
  return tier1CountDispatchableNodes(nodes, req, attempted, now, knownModels, maxInFlight);
}

export type TierPickResult = {
  node?: RuntimeNode;
  raceLost?: boolean;
  raceLostNodeId?: string;
  tier1ReleaseToken?: { accountId: string; modelId: string | null; released: boolean; settled: boolean; quotaReserved: number } | null;
  tier1EscapedFromAffinity?: boolean;
  tier1UpdateAffinity?: boolean;
  tier1AffinityHit?: boolean;
} | null;

type PickForTierOpts = {
  knownModels?: ReadonlySet<string> | null;
  affinityAccountId?: string | null;
  evaluateAffinity?: boolean;
  now?: number;
  rng?: () => number;
  excludeId?: string | null;
  raceLostIds?: Set<string> | null;
  maxInFlight?: number | null;
};

export function pickForTier(
  tierNumber: Tier,
  tierNodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  opts: PickForTierOpts = {},
): TierPickResult {
  const r = routingStrategyFor(tierNumber).pick(tierNodes, req, attempted, opts);
  if (!r) return null;
  if (r.raceLost) return { raceLost: true, raceLostNodeId: r.raceLostNodeId };
  return {
    node: r.node,
    tier1ReleaseToken: r.releaseToken,
    tier1EscapedFromAffinity: r.escapedFromAffinity,
    tier1UpdateAffinity: r.updateAffinity,
    tier1AffinityHit: r.affinityHit,
  };
}

export function makeTier1Rng(env: GatewayEnv): () => number {
  const seedRaw = String(env?.TIER1_SCHEDULER_SEED ?? '').trim();
  if (!seedRaw) return cryptoRng;
  let h = 1779033703 ^ seedRaw.length;
  for (let i = 0; i < seedRaw.length; i++) {
    h = Math.imul(h ^ seedRaw.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeTierCaps(
  tiers: TierMap<RuntimeNode[]>,
  reqDescriptor: RoutableRequest,
  attempted: Set<string>,
  policy: PolicyConfig,
  knownModels: ReadonlySet<string>,
  maxInFlight?: number | null,
  consumed?: Partial<Record<Tier, number>>,
): TierMap<number> {
  const now = Date.now();
  const caps: TierMap<number> = { 1: 0, 2: 0 };

  const applyConsumed = (): TierMap<number> => {
    if (!consumed) return caps;
    for (const tier of TIER_ORDER) caps[tier] = Math.max(0, (caps[tier] ?? 0) - (consumed[tier] ?? 0));
    return caps;
  };

  const dispatchable = TIER_ORDER.filter((t) =>
    t === 1
      ? tier1Dispatchable(tiers[t], reqDescriptor, attempted, now, knownModels, maxInFlight)
      : tierHasDispatchableNode(tiers[t], reqDescriptor, attempted, now, knownModels),
  );
  if (dispatchable.length === 0) return applyConsumed();

  const max = policy.maxAttempts;
  const explicitTotal = dispatchable.reduce((sum, t) => sum + (policy.tierAttempts?.[`tier${t}`] ?? 0), 0);
  const adjustable = dispatchable.filter((t) => policy.tierAttempts?.[`tier${t}`] === undefined);

  for (const t of dispatchable) {
    const override = policy.tierAttempts?.[`tier${t}`];
    if (override !== undefined) caps[t] = override;
  }

  if (adjustable.length === 0) return applyConsumed();
  const remaining = Math.max(0, max - explicitTotal);
  if (remaining === 0) return applyConsumed();

  const baselineCount = Math.min(remaining, adjustable.length);
  for (const tier of adjustable.slice(0, baselineCount)) caps[tier] = 1;
  const firstAdjustable = adjustable[0];
  if (remaining > baselineCount && firstAdjustable !== undefined) caps[firstAdjustable] += remaining - baselineCount;
  return applyConsumed();
}

export function redistributeUnusedTierAttempts(
  caps: TierMap<number>,
  afterTier: Tier,
  unusedAttempts: number,
  policy: PolicyConfig,
): TierMap<number> {
  const unused = Number.isFinite(unusedAttempts) ? Math.max(0, Math.trunc(unusedAttempts)) : 0;
  if (unused === 0) return caps;
  const next = TIER_ORDER.find((tier) => tier > afterTier && policy.tierAttempts?.[`tier${tier}`] === undefined);
  if (next !== undefined) caps[next] = (caps[next] ?? 0) + unused;
  return caps;
}

export function countRemainingDispatchableAttempts(
  tiers: TierMap<RuntimeNode[]>,
  reqDescriptor: RoutableRequest,
  attempted: Set<string>,
  tierCaps: TierMap<number>,
  currentTier: Tier,
  usedInTier: number,
  sharedRemaining: number,
  knownModels: ReadonlySet<string>,
  maxInFlight?: number | null,
): number {
  const now = Date.now();
  let total = 0;
  let hasReachedCurrentTier = false;
  for (const tierNumber of TIER_ORDER) {
    if (tierNumber === currentTier) hasReachedCurrentTier = true;
    if (!hasReachedCurrentTier) continue;
    const capRemaining = Math.max(0, (tierCaps[tierNumber] ?? 0) - (tierNumber === currentTier ? usedInTier : 0));
    if (capRemaining === 0) continue;
    const live =
      tierNumber === 1
        ? tier1LiveCount(tiers[tierNumber], reqDescriptor, attempted, now, knownModels, maxInFlight)
        : countDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels);
    total += Math.min(capRemaining, live);
  }
  return Math.max(1, Math.min(Math.max(1, sharedRemaining), total || 1));
}
