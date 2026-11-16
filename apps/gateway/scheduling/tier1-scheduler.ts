import { tier1CanAcceptHedge, tier1SelectionHeatFactor } from '../../../src/reliability/tier1-heat.ts';
import { claimTier1Slot, isTier1Eligible, makeTier1ReleaseToken, maybeTransitionToHalfOpen } from '../../../src/reliability/tier1-state.ts';
import { calculateTier1Score } from '../../../src/scheduler/tier1-scoring.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';
import type { PickedCandidate, RoutableRequest } from '../../../src/types/scheduler.ts';
import { cryptoRng } from '../../../src/utils/crypto-rng.ts';
import { affinityShouldEscape, tier1AffinityFactor } from './tier1-affinity.ts';

const CONSERVATIVE_ATTEMPT_COST_MS = 500;
export function tier1DeadlineTooSmall(remainingBudgetMs: number, p99TtftMs?: number | null): boolean {
  const cost = p99TtftMs && p99TtftMs > 0 ? p99TtftMs * 3 : CONSERVATIVE_ATTEMPT_COST_MS;
  return remainingBudgetMs < cost;
}

export function pickTier1Candidate(
  tier1Nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  {
    affinityAccountId = null,
    evaluateAffinity = false,
    now = Date.now(),
    excludeId = null,
    rng = cryptoRng,
    knownModels = null,
    raceLostIds = null,
    maxInFlight = null,
  }: {
    affinityAccountId?: string | null;
    evaluateAffinity?: boolean;
    now?: number;
    excludeId?: string | null;
    rng?: () => number;
    knownModels?: ReadonlySet<string> | null;
    raceLostIds?: Set<string> | null;
    maxInFlight?: number | null;
  } = {},
): PickedCandidate | null {
  const eligible: RuntimeNode[] = [];
  for (const node of tier1Nodes) {
    if (node.id === excludeId) continue;
    if (raceLostIds?.has(node.id)) continue;
    if (attempted.has(node.id)) continue;
    maybeTransitionToHalfOpen(node.id, req.model, now);
    if (!isTier1Eligible(node, req, now, knownModels, maxInFlight)) continue;
    if (excludeId && !tier1CanAcceptHedge(node)) continue;
    eligible.push(node);
  }
  if (eligible.length === 0) return null;

  const affinityNode = affinityAccountId ? eligible.find((n) => n.id === affinityAccountId) : null;

  let chosen: RuntimeNode;
  let hasEscapedFromAffinity = false;
  let updateAffinity = !affinityAccountId;

  const selectionFactor = (node: RuntimeNode): number => tier1SelectionHeatFactor(node, tier1AffinityFactor(node.id, affinityAccountId));
  const scoreFor = (node: RuntimeNode): number => calculateTier1Score(node, req.model, eligible, selectionFactor(node), now);

  if (eligible.length === 1) {
    const only = eligible[0];
    if (!only) return null;
    chosen = only;
  } else {
    const { a, b } = sampleTwo(eligible, rng, affinityNode);
    const scoreA = scoreFor(a);
    const scoreB = scoreFor(b);
    const p2cWinner = scoreA <= scoreB ? a : b;
    const p2cWinnerScore = Math.min(scoreA, scoreB);

    if (affinityNode && affinityNode.id !== p2cWinner.id) {
      const affScore = scoreA;
      if (evaluateAffinity && affinityShouldEscape(affScore, p2cWinnerScore)) {
        chosen = p2cWinner;
        hasEscapedFromAffinity = true;
        updateAffinity = true;
      } else if (evaluateAffinity) {
        chosen = affinityNode;
      } else {
        chosen = p2cWinner;
      }
    } else {
      chosen = p2cWinner;
    }
  }

  if (affinityAccountId && !affinityNode) updateAffinity = true;

  if (!claimTier1Slot(chosen, now, req.model, maxInFlight)) {
    return { raceLost: true, raceLostNodeId: chosen.id };
  }
  return {
    node: chosen,
    releaseToken: makeTier1ReleaseToken(chosen.id, req.model),
    escapedFromAffinity: hasEscapedFromAffinity,
    updateAffinity,
    affinityHit: Boolean(affinityAccountId && chosen.id === affinityAccountId),
  };
}

function sampleTwo(arr: RuntimeNode[], rng: () => number = cryptoRng, affinityNode: RuntimeNode | null = null): { a: RuntimeNode; b: RuntimeNode } {
  if (affinityNode) {
    const pinnedIndex = arr.indexOf(affinityNode);
    if (pinnedIndex < 0) throw new Error('tier1 P2C invariant: affinity candidate is not eligible');
    let peerIndex = Math.floor(rng() * (arr.length - 1));
    if (peerIndex >= pinnedIndex) peerIndex += 1;
    const peer = arr[peerIndex];
    if (!peer) throw new Error('tier1 P2C invariant: affinity candidate requires a peer');
    return { a: affinityNode, b: peer };
  }
  const i = Math.floor(rng() * arr.length);
  let j = Math.floor(rng() * (arr.length - 1));
  if (j >= i) j += 1;
  const a = arr[i];
  const b = arr[j];
  if (!a || !b) throw new Error('tier1 P2C invariant: two candidates required');
  return { a, b };
}

export function tier1ModelAvailability(
  tier1Nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  now: number,
  knownModels?: ReadonlySet<string> | null,
  maxInFlight?: number | null,
  excludedNodeIds?: ReadonlySet<string> | null,
): number {
  const eligible: RuntimeNode[] = [];
  for (const node of tier1Nodes) {
    if (excludedNodeIds?.has(node.id)) continue;
    if (isTier1Eligible(node, req, now, knownModels, maxInFlight)) eligible.push(node);
  }
  let best = Infinity;
  for (const node of eligible) {
    best = Math.min(best, calculateTier1Score(node, req.model, eligible, tier1SelectionHeatFactor(node, 1), now));
  }
  return best;
}
