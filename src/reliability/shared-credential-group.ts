// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Explicit non-secret identity for nodes intentionally sharing an upstream Key.
import type { RuntimeNode } from '../../packages/contracts/runtime-node.ts';
import { TIER1_429_ACCOUNT_ESCALATION_MODELS, TIER1_429_ACCOUNT_ESCALATION_WINDOW_MS } from './tier1-definitions.ts';

export function credentialSlotId(node: RuntimeNode): string {
  return node.keyGroup ? JSON.stringify(['shared-key', node.tier, node.provider, node.baseUrl, node.keyGroup]) : node.id;
}

export function credentialPeers(nodes: readonly RuntimeNode[], node: RuntimeNode): RuntimeNode[] {
  if (!node.keyGroup) return [];
  return nodes.filter(
    (peer) =>
      peer.id !== node.id &&
      peer.keyGroup === node.keyGroup &&
      peer.tier === node.tier &&
      peer.provider === node.provider &&
      peer.baseUrl === node.baseUrl,
  );
}

// Short-lived quota-scope evidence across physical models on the SAME Key.
// Not a capability memory, not a global quota counter, and never persisted.
const recentModels = new Map<string, Map<string, number>>();
export function noteKeyGroup429(node: RuntimeNode, physicalModel: string, now: number = Date.now()): 'model' | 'account' {
  if (!node.keyGroup) return 'model';
  const key = credentialSlotId(node);
  const seen = recentModels.get(key) ?? new Map<string, number>();
  for (const [model, at] of seen) if (at <= now - TIER1_429_ACCOUNT_ESCALATION_WINDOW_MS) seen.delete(model);
  seen.set(physicalModel, now);
  recentModels.set(key, seen);
  if (recentModels.size > 512) {
    for (const [id, models] of recentModels) {
      for (const [model, at] of models) if (at <= now - TIER1_429_ACCOUNT_ESCALATION_WINDOW_MS) models.delete(model);
      if (models.size === 0) recentModels.delete(id);
    }
    while (recentModels.size > 512) recentModels.delete(recentModels.keys().next().value as string);
  }
  return seen.size >= TIER1_429_ACCOUNT_ESCALATION_MODELS ? 'account' : 'model';
}
export function __resetKeyGroupForTests(): void {
  recentModels.clear();
}
