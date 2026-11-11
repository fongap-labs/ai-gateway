// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Config-driven logical-model fallback. Model names are opaque identifiers.
// AIG_MODELS_CONFIG.fallback owns eligible aliases and their declared order.
// A model without explicit fallback does not acquire neighbors by its spelling.
// At most two rounds run, bounded by the original request-wide attempt budget.

import type { ModelEntry } from '../../../src/config/models.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';

const DEFAULT_FAMILY_ATTEMPT_BUDGET = 6;
export type ModelFallbackPass = { model: string; attemptCap: number | null };

function keyOf(model: string): string {
  return model.trim().toLowerCase();
}

function catalogByKey(knownModels: ReadonlySet<string>): Map<string, string> {
  const catalog = new Map<string, string>();
  for (const model of knownModels) {
    const key = keyOf(model);
    if (key && !catalog.has(key)) catalog.set(key, model);
  }
  return catalog;
}

function configuredTargets(requested: string, modelsConfig: Record<string, ModelEntry>): readonly string[] {
  const exact = modelsConfig[requested];
  if (exact) return exact.policy.fallback ?? [];
  const key = keyOf(requested);
  return Object.entries(modelsConfig).find(([name]) => keyOf(name) === key)?.[1].policy.fallback ?? [];
}

/**
 * Only configured, callable aliases enter the fallback rounds. Recheck each
 * sibling once but do not move back to the requested alias in round two.
 * This preserves one-way Air-style fallback without identifying a name as Air.
 */
export function buildModelFallbackRounds(
  requestedModel: string,
  knownModels: ReadonlySet<string>,
  modelsConfig: Record<string, ModelEntry> = {},
): string[][] {
  const catalog = catalogByKey(knownModels);
  const first = [requestedModel];
  const seen = new Set([keyOf(requestedModel)]);
  for (const target of configuredTargets(requestedModel, modelsConfig)) {
    const key = keyOf(target);
    const resolved = catalog.get(key);
    if (resolved && !seen.has(key)) {
      first.push(resolved);
      seen.add(key);
    }
  }
  return first.length > 1 ? [first, first.slice(1)] : [first];
}

function normalizedBudget(maxAttempts: number): number {
  if (!Number.isFinite(maxAttempts)) return DEFAULT_FAMILY_ATTEMPT_BUDGET;
  return Math.max(1, Math.trunc(maxAttempts));
}

function firstRoundPlan(round: readonly string[], maxAttempts: number): ModelFallbackPass[] {
  // Widen first, then deepen. For a four-model family keep the 3/1/1/1
  // attempt preference, and for a three-model family use 3/2/1.
  const visible = round.slice(0, Math.min(round.length, maxAttempts));
  const caps = visible.map(() => 1);
  let remaining = Math.max(0, maxAttempts - visible.length);
  const preference = round.length >= 4 ? [3, 1, 1, 1] : [3, 2, 1];
  for (const [i] of visible.entries()) {
    if (!remaining) break;
    const current = caps[i] ?? 1;
    const extra = Math.min(remaining, Math.max(0, (preference[i] ?? 1) - current));
    caps[i] = current + extra;
    remaining -= extra;
  }
  return visible.map((model, i) => ({ model, attemptCap: caps[i] ?? 1 }));
}

export function buildModelFallbackPlan(
  requestedModel: string,
  knownModels: ReadonlySet<string>,
  maxAttempts: number = DEFAULT_FAMILY_ATTEMPT_BUDGET,
  modelsConfig: Record<string, ModelEntry> = {},
): ModelFallbackPass[][] {
  const rounds = buildModelFallbackRounds(requestedModel, knownModels, modelsConfig);
  if ((rounds[0]?.length ?? 0) <= 1) return [[{ model: requestedModel, attemptCap: null }]];
  const first = firstRoundPlan(rounds[0], normalizedBudget(maxAttempts));
  const allowed = new Set(first.map(({ model }) => keyOf(model)));
  const result: ModelFallbackPass[][] = [first];
  const second = (rounds[1] ?? [])
    .filter((model) => allowed.has(keyOf(model)))
    .map((model) => ({ model, attemptCap: 1 }));
  if (second.length) result.push(second);
  return result;
}

export function pickNextModelPass(
  pending: ReadonlyArray<ModelFallbackPass>,
  requestedModel: string,
  availabilityOf: (model: string) => number,
): number {
  const requestedKey = keyOf(requestedModel);
  let best = 0;
  let bestScore = Infinity;
  for (const [index, pass] of pending.entries()) {
    const score = availabilityOf(pass.model);
    if (keyOf(pass.model) === requestedKey && Number.isFinite(score)) return index;
    if (score < bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}

/** An explicit fallback list, not a model-name suffix, defines a family. */
export function hasModelFamilyFallback(requestedModel: string, modelsConfig: Record<string, ModelEntry> = {}): boolean {
  return configuredTargets(requestedModel, modelsConfig).length > 0;
}

export function modelFallbackCandidates(
  requestedModel: string,
  knownModels: ReadonlySet<string>,
  modelsConfig: Record<string, ModelEntry> = {},
): string[] {
  return [...new Set(buildModelFallbackRounds(requestedModel, knownModels, modelsConfig).flat())];
}

/**
 * Request-local failure-domain identity for logical-model fallback.
 *
 * One RuntimeNode is one configured upstream account/key-slot identity. If two
 * logical aliases on that same node resolve to the same upstream model, they
 * are the same real failure domain and must not consume separate retry budget
 * after one of them has already failed in this request. Protocol/base URL are
 * node properties, and surface changes do not create fresh account/model
 * capacity, so neither belongs in the key.
 *
 * Raw credentials are deliberately excluded. The gateway never hashes,
 * compares, logs or persists secret material merely to deduplicate retries.
 */
export function modelFailureDomainKey(node: RuntimeNode, logicalModel: string): string {
  const upstreamModel = node.models[logicalModel] || logicalModel;
  return JSON.stringify([node.id, upstreamModel]);
}

/**
 * Seed a new logical-model pass with nodes whose real account/model domain has
 * already failed earlier in this request. A node mapped to a DIFFERENT real
 * upstream model stays eligible, even when it is the same configured account.
 * A different node/account mapped to the same model also stays eligible.
 */
export function failedDomainNodeIds(nodes: ReadonlyArray<RuntimeNode>, logicalModel: string, failedDomains: ReadonlySet<string>): Set<string> {
  const attempted = new Set<string>();
  if (failedDomains.size === 0) return attempted;
  for (const node of nodes) {
    if (failedDomains.has(modelFailureDomainKey(node, logicalModel))) {
      attempted.add(node.id);
    }
  }
  return attempted;
}

/** Record the actual node/model domains touched by one failed logical pass. */
export function rememberFailedDomains(
  failedDomains: Set<string>,
  nodesById: ReadonlyMap<string, RuntimeNode>,
  attemptedNodeIds: ReadonlySet<string>,
  logicalModel: string,
): void {
  for (const nodeId of attemptedNodeIds) {
    const node = nodesById.get(nodeId);
    if (node) failedDomains.add(modelFailureDomainKey(node, logicalModel));
  }
}
