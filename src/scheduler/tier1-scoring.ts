// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Tier 1 score construction belongs to scheduling. Reliability exposes
// isolate-local observations/state; this module decides how those facts are
// combined into a bounded ranking score. No state is mutated here.

import {
  getTier1ModelPerf,
  tier1QuotaState,
  TIER1_FAILURE_STATES,
} from '../reliability/tier1-state.ts';
import { tier1ProviderModelHeatFactor } from '../reliability/tier1-heat.ts';
import type { RuntimeNode } from '../types/node.ts';

export const TIER1_EXPLORATION_FACTOR = 0.9;
export const TIER1_HALF_OPEN_SCORE_PENALTY = 1.4;
export const TIER1_NEUTRAL_TTFT_MS = 800; // scheduling fallback, never persisted

// TTFT scoring: bounded multiplicative demotion (not a raw latency sort).
export const TIER1_SCORE_BASE = 1000;
export const TIER1_TTFT_WEIGHT = 0.25;
export const TIER1_TTFT_FACTOR_MIN = 0.85;
export const TIER1_TTFT_FACTOR_MAX = 1.50;

function median(values: ReadonlyArray<number>): number {
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length === 0) return TIER1_NEUTRAL_TTFT_MS;
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle];
  if (upper === undefined) return TIER1_NEUTRAL_TTFT_MS;
  if (ordered.length % 2) return upper;
  const lower = ordered[middle - 1] ?? upper;
  return (lower + upper) / 2;
}

export function effectiveTier1Ttft(accountId: string, modelId: string, candidates: ReadonlyArray<RuntimeNode>): number {
  const own = getTier1ModelPerf(accountId, modelId);
  if (own?.ttftEwma != null && own.sampleCount > 0) return own.ttftEwma;
  const known: number[] = [];
  for (const candidate of candidates ?? []) {
    if (candidate.id === accountId) continue;
    const metric = getTier1ModelPerf(candidate.id, modelId);
    if (metric?.ttftEwma != null && metric.sampleCount > 0) known.push(metric.ttftEwma);
  }
  return known.length ? median(known) : TIER1_NEUTRAL_TTFT_MS;
}

function failureFactor(accountId: string, modelId: string): number {
  return getTier1ModelPerf(accountId, modelId)?.failureState === TIER1_FAILURE_STATES.HALF_OPEN
    ? TIER1_HALF_OPEN_SCORE_PENALTY : 1;
}

function quotaFactor(accountId: string, now: number): number {
  return tier1QuotaState(accountId, now) === 'near_limit' ? 1.2 : 1;
}

function explorationFactor(accountId: string, modelId: string): number {
  const metric = getTier1ModelPerf(accountId, modelId);
  return !metric || metric.ttftEwma == null || metric.sampleCount === 0
    ? TIER1_EXPLORATION_FACTOR : 1;
}

function tier1TtftBaseline(modelId: string, candidates: ReadonlyArray<RuntimeNode>): number {
  const known: number[] = [];
  for (const candidate of candidates ?? []) {
    const metric = getTier1ModelPerf(candidate.id, modelId);
    if (
      metric?.ttftEwma != null
      && metric.sampleCount > 0
      && Number.isFinite(metric.ttftEwma)
    ) {
      known.push(metric.ttftEwma);
    }
  }
  return known.length ? median(known) : TIER1_NEUTRAL_TTFT_MS;
}

function ttftFactor(accountId: string, modelId: string, candidates: ReadonlyArray<RuntimeNode>): number {
  const metric = getTier1ModelPerf(accountId, modelId);
  if (!metric || metric.ttftEwma == null || metric.sampleCount === 0) {
    return 1; // unknown nodes are handled by explorationFactor, not demoted here
  }
  const baseline = tier1TtftBaseline(modelId, candidates);
  const ratio = metric.ttftEwma / Math.max(1, baseline);
  return Math.min(
    TIER1_TTFT_FACTOR_MAX,
    Math.max(TIER1_TTFT_FACTOR_MIN, 1 + TIER1_TTFT_WEIGHT * (ratio - 1)),
  );
}

function upstreamModelOf(node: RuntimeNode, logicalModel: string): string {
  return node.models[logicalModel] || logicalModel;
}

export function calculateTier1Score(
  node: RuntimeNode,
  modelId: string,
  candidates: ReadonlyArray<RuntimeNode>,
  affinityFactor: number = 1,
  now: number = Date.now(),
): number {
  return Math.max(1,
    TIER1_SCORE_BASE
    * ttftFactor(node.id, modelId, candidates)
    * failureFactor(node.id, modelId)
    * quotaFactor(node.id, now)
    * tier1ProviderModelHeatFactor(node.provider, upstreamModelOf(node, modelId), now)
    * affinityFactor
    * explorationFactor(node.id, modelId));
}
