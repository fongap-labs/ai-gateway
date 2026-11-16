// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { RegistryEntry } from '../config/registry.ts';
import { collectKnownModels, loadModelRegistry, servesModel } from '../config/registry.ts';
import { normalizeModelKey } from '../observability/token-usage-store.ts';
import type { RuntimeNode } from '../types/node.ts';
import { getRuntimeAvailability } from './availability.ts';

export {
  MODEL_STATUS_HISTORICAL_WINDOW_MS,
  MODEL_STATUS_RECENT_WINDOW_MS,
} from '../observability/token-usage-store.ts';

export type PublicModelStatusState = 'available' | 'fluctuating' | 'no_recent' | 'no_record' | 'down';

export type PublicModelStatusEntry = {
  id: string;
  status: PublicModelStatusState;
  display_order: number;
  group: string;
};

function deriveGroup(name: string): string {
  if (name.startsWith('Code-')) return 'code';
  if (name === 'Omni') return 'omni';
  if (name === 'OCR') return 'ocr';
  return 'general';
}

const MODEL_NAME_PRIORITY: Record<string, number> = {
  air: 10,
  pro: 20,
  max: 30,
  ultra: 40,
};
const GROUP_PRIORITY: Record<string, number> = { general: 0, code: 1, omni: 2, ocr: 3 };
function modelNamePriority(name: string): number {
  const lower = name.toLowerCase().replace(/^code-/, '');
  return MODEL_NAME_PRIORITY[lower] ?? 90;
}

export function getPublicModelStatus(
  nodes: ReadonlyArray<RuntimeNode>,
  env: Record<string, unknown> | null | undefined,
  evidence: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
  historicalEvidence: ReadonlySet<string> = new Set(),
): { observed_at: string; models: PublicModelStatusEntry[] } {
  const names = new Set<string>();
  for (const node of nodes || []) {
    for (const key of Object.keys(node.models || {})) names.add(key);
  }
  const visibility: Record<string, string> = {};
  const uiVisible: Record<string, boolean> = {};
  let registry: Record<string, RegistryEntry> = {};
  if (env) {
    try {
      registry = loadModelRegistry(env);
      for (const [name, entry] of Object.entries(registry)) {
        visibility[name] = entry.policy.visibility || 'public';
        uiVisible[name] = entry.policy.ui_visible !== false;
      }
    } catch {}
  }
  const canonicalEvidence = new Set<string>();
  for (const key of evidence instanceof Set ? evidence : new Set()) {
    const canonical = normalizeModelKey(key);
    if (canonical) canonicalEvidence.add(canonical);
  }
  const canonicalHistorical = new Set<string>();
  for (const key of historicalEvidence instanceof Set ? historicalEvidence : new Set()) {
    const canonical = normalizeModelKey(key);
    if (canonical) canonicalHistorical.add(canonical);
  }
  const knownModels = collectKnownModels(nodes, env ?? undefined);
  const models: PublicModelStatusEntry[] = [];
  for (const name of [...names]) {
    if (visibility[name] === 'internal') continue;
    if (uiVisible[name] === false) continue;
    const serving = (nodes || []).filter((n) => servesModel(n, name, knownModels));
    const status = modelStatus(name, serving, canonicalEvidence, canonicalHistorical, now);
    const entry: RegistryEntry | undefined = registry[name];
    models.push({
      id: name,
      status,
      display_order: entry?.policy.display_order !== undefined ? entry?.policy.display_order : 100,
      group: entry?.policy.group !== undefined ? entry?.policy.group : deriveGroup(name),
    });
  }
  models.sort((a, b) => {
    const ga = GROUP_PRIORITY[a.group] ?? 9;
    const gb = GROUP_PRIORITY[b.group] ?? 9;
    if (ga !== gb) return ga - gb;
    const diff = a.display_order - b.display_order;
    if (diff !== 0) return diff;
    const pa = modelNamePriority(a.id);
    const pb = modelNamePriority(b.id);
    return pa !== pb ? pa - pb : a.id.localeCompare(b.id);
  });
  return { observed_at: new Date(now).toISOString(), models };
}

function modelStatus(
  name: string,
  serving: RuntimeNode[],
  recentEvidence: ReadonlySet<string>,
  historicalEvidence: ReadonlySet<string>,
  now: number,
): PublicModelStatusState {
  if (!serving.length) return 'down';

  const states = serving.map((n) => getRuntimeAvailability(n, name, now));
  const key = normalizeModelKey(name);
  const hasRecent = recentEvidence.has(key);
  const hasHistory = historicalEvidence.has(key);

  const anyAvailable = states.some((s) => s === 'available');
  const allDown = states.every((s) => s === 'unavailable');
  const anyUnobserved = states.some((s) => s === 'unobserved');

  if (anyAvailable) return 'available';
  if (allDown) return hasRecent ? 'fluctuating' : 'down';
  if (anyUnobserved && hasRecent) return 'available';
  if (hasHistory) return 'no_recent';
  return 'no_record';
}
