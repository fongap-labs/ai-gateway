// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Config-driven logical-model fallback. Model names are opaque identifiers.
// AIG_MODELS_CONFIG.fallback owns eligible aliases and their declared order.
// A model without explicit fallback does not acquire neighbors by its spelling.
// At most two rounds run, bounded by the original request-wide attempt budget.

import { resolvePhysicalModel } from '../../../packages/config-core/registry.ts';
import type { ModelEntry } from '../../../src/config/models.ts';
import { credentialSlotId } from '../../../src/reliability/shared-credential-group.ts';
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
 * Recheck is explicit, or follows an explicit reverse fallback edge.
 * Without either, a one-way path cannot implicitly move back to its source.
 * Neither model spelling nor number of siblings is used to choose the mode.
 */
function fallbackMode(requested: string, modelsConfig: Record<string, ModelEntry>): 'one_way' | 'recheck' {
  const requestedKey = keyOf(requested);
  const entry = modelsConfig[requested] ?? Object.entries(modelsConfig).find(([name]) => keyOf(name) === requestedKey)?.[1];
  if (entry?.policy.fallback_mode) return entry.policy.fallback_mode;
  return configuredTargets(requested, modelsConfig).some((target) =>
    configuredTargets(target, modelsConfig).some((reverse) => keyOf(reverse) === requestedKey),
  )
    ? 'recheck'
    : 'one_way';
}

function configuredAttemptCaps(requested: string, modelsConfig: Record<string, ModelEntry>): readonly number[] | undefined {
  const requestedKey = keyOf(requested);
  return (modelsConfig[requested] ?? Object.entries(modelsConfig).find(([name]) => keyOf(name) === requestedKey)?.[1])?.policy.fallback_attempt_caps;
}
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
  if (first.length <= 1) return [first];
  const second = fallbackMode(requestedModel, modelsConfig) === 'one_way' ? first.slice(1) : [...first];
  return second.length ? [first, second] : [first];
}

function normalizedBudget(maxAttempts: number): number {
  if (!Number.isFinite(maxAttempts)) return DEFAULT_FAMILY_ATTEMPT_BUDGET;
  return Math.max(1, Math.trunc(maxAttempts));
}

function firstRoundPlan(
  round: readonly string[],
  maxAttempts: number,
  template: readonly string[],
  mode: 'one_way' | 'recheck',
  configuredCaps?: readonly number[],
): ModelFallbackPass[] {
  // Give every eligible model one try before deepening preferred candidates.
  // Caps are aligned with the full configured order, not the currently
  // available subset; unavailable siblings never donate an inflated cap.
  const visible = round.slice(0, Math.min(round.length, maxAttempts));
  const caps = visible.map(() => 1);
  let remaining = Math.max(0, maxAttempts - visible.length);
  const sourcePreference = Math.max(1, Math.min(template.length, maxAttempts - template.length + 1));
  for (const [i, model] of visible.entries()) {
    if (!remaining) break;
    const rank = template.findIndex((name) => keyOf(name) === keyOf(model));
    if (rank < 0) continue;
    // Derive the original v0.1.5 preference from the declared order rather
    // than hard-coding arrays or assuming 3/4 named model families.
    const desired = configuredCaps?.[rank] ?? (mode === 'recheck' ? Math.max(1, template.length - rank) : rank === 0 ? sourcePreference : 1);
    const extra = Math.min(remaining, Math.max(0, desired - (caps[i] ?? 1)));
    caps[i] = (caps[i] ?? 1) + extra;
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
  const attemptBudget = normalizedBudget(maxAttempts);
  const first = firstRoundPlan(
    rounds[0] ?? [requestedModel],
    attemptBudget,
    [requestedModel, ...configuredTargets(requestedModel, modelsConfig)],
    fallbackMode(requestedModel, modelsConfig),
    configuredAttemptCaps(requestedModel, modelsConfig),
  );
  const allowed = new Set(first.map(({ model }) => keyOf(model)));
  const result: ModelFallbackPass[][] = [first];
  // A single logical attempt has no retry capacity: never expose a recheck
  // round containing only the requested model when maxAttempts is one.
  if (attemptBudget <= 1) return result;
  const second = (rounds[1] ?? []).filter((model) => allowed.has(keyOf(model))).map((model) => ({ model, attemptCap: 1 }));
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

/** An explicit fallback list defines family membership for its source and targets. */
export function hasModelFamilyFallback(requestedModel: string, modelsConfig: Record<string, ModelEntry> = {}): boolean {
  if (configuredTargets(requestedModel, modelsConfig).length > 0) return true;
  const requestedKey = keyOf(requestedModel);
  return Object.values(modelsConfig).some((entry) => (entry.policy.fallback ?? []).some((target) => keyOf(target) === requestedKey));
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
  // An unmapped logical alias is not a physical model failure domain.
  return JSON.stringify([credentialSlotId(node), resolvePhysicalModel(node, logicalModel)]);
}

/** A real failed Key cannot be tried again under another logical alias. */
function keyFailureDomainKey(node: RuntimeNode): string {
  return JSON.stringify([credentialSlotId(node), '*failed-key*']);
}

/**
 * Seed a new model pass with both spent Key+model routes and physically failed
 * Keys. A distinct Key remains eligible even if it targets the same model.
 */
export function failedDomainNodeIds(nodes: ReadonlyArray<RuntimeNode>, logicalModel: string, failedDomains: ReadonlySet<string>): Set<string> {
  const attempted = new Set<string>();
  if (failedDomains.size === 0) return attempted;
  for (const node of nodes) {
    if (failedDomains.has(keyFailureDomainKey(node)) || failedDomains.has(modelFailureDomainKey(node, logicalModel))) {
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
  attempts: ReadonlyArray<Record<string, unknown>> = [],
): void {
  for (const nodeId of attemptedNodeIds) {
    const node = nodesById.get(nodeId);
    if (node) failedDomains.add(modelFailureDomainKey(node, logicalModel));
  }
  // An account-wide or transient execution failure exhausts the physical
  // Key for this request, regardless of which logical model is tried next.
  // Model-missing and endpoint-specific refusals remain scoped to the failing
  // physical model: another model on that Key may still be valid.
  const keyFailures = new Set(['auth', 'server', 'network', 'headers_timeout', 'first_event_timeout', 'stream_interrupted']);
  for (const attempt of attempts) {
    if (attempt.dispatched !== true || typeof attempt.node_id !== 'string') continue;
    const node = nodesById.get(attempt.node_id);
    // A model-scoped 429 must not exclude unrelated physical models on the Key.
    if (node && (keyFailures.has(String(attempt.kind)) || (attempt.kind === 'rate_limit' && attempt.rate_limit_scope === 'account'))) {
      failedDomains.add(keyFailureDomainKey(node));
    }
  }
}
