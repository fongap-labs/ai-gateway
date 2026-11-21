import { resolvePhysicalModel } from '../../../packages/config-core/registry.ts';
import type { ModelEntry } from '../../../src/config/models.ts';
import { credentialSlotId } from '../../../src/reliability/shared-credential-group.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';
import { isCredentialWideFailure } from '../reliability/retry-budget.ts';

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
  const visible = round.slice(0, Math.min(round.length, maxAttempts));
  const caps = visible.map(() => 1);
  let remaining = Math.max(0, maxAttempts - visible.length);
  const sourcePreference = Math.max(1, Math.min(template.length, maxAttempts - template.length + 1));
  for (const [i, model] of visible.entries()) {
    if (!remaining) break;
    const rank = template.findIndex((name) => keyOf(name) === keyOf(model));
    if (rank < 0) continue;
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

export function modelFailureDomainKey(node: RuntimeNode, logicalModel: string): string {
  return JSON.stringify([credentialSlotId(node), resolvePhysicalModel(node, logicalModel)]);
}

export function physicalRouteFailureDomainKey(node: RuntimeNode, logicalModel: string, surface: string): string {
  return JSON.stringify(['physical-route', node.tier, node.provider, node.baseUrl, node.protocol, surface, resolvePhysicalModel(node, logicalModel)]);
}

function keyFailureDomainKey(node: RuntimeNode): string {
  return JSON.stringify([credentialSlotId(node), '*failed-key*']);
}

export function failedDomainNodeIds(
  nodes: ReadonlyArray<RuntimeNode>,
  logicalModel: string,
  failedDomains: ReadonlySet<string>,
  surface?: string,
): Set<string> {
  const attempted = new Set<string>();
  if (failedDomains.size === 0) return attempted;
  for (const node of nodes) {
    if (
      failedDomains.has(keyFailureDomainKey(node)) ||
      failedDomains.has(modelFailureDomainKey(node, logicalModel)) ||
      (surface !== undefined && failedDomains.has(physicalRouteFailureDomainKey(node, logicalModel, surface)))
    ) {
      attempted.add(node.id);
    }
  }
  return attempted;
}

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
  const keyFailures = new Set(['auth', 'server', 'network', 'headers_timeout', 'first_event_timeout', 'stream_interrupted']);
  for (const attempt of attempts) {
    if (attempt.dispatched !== true || typeof attempt.node_id !== 'string') continue;
    const node = nodesById.get(attempt.node_id);
    if (!node) continue;
    if (keyFailures.has(String(attempt.kind)) || isCredentialWideFailure(attempt)) {
      failedDomains.add(keyFailureDomainKey(node));
    }
    const rejectedRoute =
      (attempt.kind === 'model_missing' && attempt.status === 404) ||
      attempt.kind === 'endpoint_not_found' ||
      (attempt.kind === 'client' && attempt.status === 422);
    const attemptSurface = typeof attempt.surface === 'string' ? attempt.surface : '';
    const attemptedModel = typeof attempt.effective_model === 'string' ? attempt.effective_model : logicalModel;
    if (rejectedRoute && attemptSurface) {
      failedDomains.add(physicalRouteFailureDomainKey(node, attemptedModel, attemptSurface));
    }
  }
}
