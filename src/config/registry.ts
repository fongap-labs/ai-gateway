// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Model Registry — single source of truth for logical-model catalog facts
// and runtime policy. Catalog facts (capabilities, reasoning efforts,
// modalities) and runtime policy (failover policy binding, visibility, UI
// grouping) are distinct concepts: the registry resolves defaults per side
// and never mixes them into one flat record. Runtime Nodes own only
// logical -> upstream mappings.

import { loadModelsConfig } from './models.ts';
import type { ModelCatalogFacts, ModelRuntimePolicy } from './models.ts';

export type { ModelCatalogFacts, ModelRuntimePolicy } from './models.ts';

const DEFAULT_CAPABILITIES = Object.freeze({ tools: false, reasoning: false, vision: false, stream: true, ocr: false });
const DEFAULT_REASONING_EFFORTS: readonly string[] = Object.freeze([]);
const DEFAULT_POLICY = 'default';
const DEFAULT_VISIBILITY = 'public';
const DEFAULT_DISPLAY_ORDER = 100;
const DEFAULT_GROUP = 'general';
const DEFAULT_UI_VISIBLE = true;

/** Resolved catalog facts: declared values with registry defaults applied. */
export type ResolvedModelCatalog = {
  capabilities: Record<string, boolean>,
  reasoning_efforts: string[],
  modalities?: { input: string[], output: string[] },
};

/** Resolved runtime policy: declared values with registry defaults applied. */
export type ResolvedModelPolicy = {
  policy: string,
  visibility: string,
  display_order: number,
  group: string,
  ui_visible: boolean,
};

export type RegistryEntry = {
  catalog: ResolvedModelCatalog,
  policy: ResolvedModelPolicy,
};

let cachedEnv: Record<string, unknown> | undefined;
let cachedRegistry: Record<string, RegistryEntry> | undefined;

function resolveCatalog(facts: ModelCatalogFacts): ResolvedModelCatalog {
  return {
    capabilities: { ...DEFAULT_CAPABILITIES, ...(facts.capabilities || {}) },
    reasoning_efforts: Array.isArray(facts.reasoning_efforts) && facts.reasoning_efforts.length
      ? facts.reasoning_efforts
      : [...DEFAULT_REASONING_EFFORTS],
    ...(facts.modalities ? { modalities: facts.modalities } : {}),
  };
}

function resolvePolicy(entryPolicy: ModelRuntimePolicy): ResolvedModelPolicy {
  return {
    policy: entryPolicy.policy || DEFAULT_POLICY,
    visibility: entryPolicy.visibility || DEFAULT_VISIBILITY,
    display_order: entryPolicy.display_order !== undefined ? entryPolicy.display_order : DEFAULT_DISPLAY_ORDER,
    group: entryPolicy.group !== undefined ? entryPolicy.group : DEFAULT_GROUP,
    ui_visible: entryPolicy.ui_visible !== undefined ? entryPolicy.ui_visible : DEFAULT_UI_VISIBLE,
  };
}

export function loadModelRegistry(env: Record<string, unknown>): Record<string, RegistryEntry> {
  if (cachedEnv === env && cachedRegistry) return cachedRegistry;
  cachedEnv = env;
  const models = loadModelsConfig(env);
  const registry: Record<string, RegistryEntry> = {};
  for (const [name, cfg] of Object.entries(models)) {
    registry[name] = {
      catalog: resolveCatalog(cfg.catalog),
      policy: resolvePolicy(cfg.policy),
    };
  }
  cachedRegistry = registry;
  return registry;
}

export function modelRegistryEntry(env: Record<string, unknown>, model: string): RegistryEntry {
  const registry = loadModelRegistry(env);
  return registry[model] || {
    catalog: {
      capabilities: { ...DEFAULT_CAPABILITIES },
      reasoning_efforts: [...DEFAULT_REASONING_EFFORTS],
    },
    policy: {
      policy: DEFAULT_POLICY,
      visibility: DEFAULT_VISIBILITY,
      display_order: DEFAULT_DISPLAY_ORDER,
      group: DEFAULT_GROUP,
      ui_visible: DEFAULT_UI_VISIBLE,
    },
  };
}

export function listRegistryModels(env: Record<string, unknown>): string[] {
  return Object.keys(loadModelRegistry(env)).sort();
}

export function isWildcardNode(node: { models: Record<string, string> }): boolean {
  return Object.keys(node.models).length === 0;
}

// Empty `models:{}` is an intentional wildcard ONLY inside the known logical
// model catalog. Without that catalog, wildcard routing fails closed; callers
// no longer receive an old permissive fallback.
export function servesModel(
  node: { models: Record<string, string> },
  model: string,
  knownModels?: ReadonlySet<string> | null,
): boolean {
  if (isWildcardNode(node)) return !!knownModels?.has(model);
  return Object.hasOwn(node.models, model);
}

// One canonical Known Model Catalog: explicit node mappings + MODELS_CONFIG.
export function collectKnownModels(
  nodes?: ReadonlyArray<{ models?: Record<string, string> } | null | undefined>,
  env?: Record<string, unknown>,
): Set<string> {
  const set = new Set<string>();
  for (const n of nodes || []) {
    for (const k of Object.keys(n?.models || {})) set.add(k);
  }
  if (env) {
    try {
      const models = loadModelsConfig(env);
      for (const name of Object.keys(models)) set.add(name);
    } catch { /* config diagnostics own malformed MODELS_CONFIG */ }
  }
  return set;
}
