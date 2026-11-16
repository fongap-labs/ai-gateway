import { hasBeenObserved, peekAvailability } from '../reliability/node-state.ts';
import { getTier1ModelPerf, isTier1Eligible, TIER1_FAILURE_STATES } from '../reliability/tier1-state.ts';
import type { RuntimeNode } from '../types/node.ts';

export type RuntimeAvailability = 'available' | 'unobserved' | 'unavailable';

/**
 * Returns one of: 'available' | 'unobserved' | 'unavailable'
 *
 * @param node  The runtime node object (has .id, .tier, .limits, .protocol, .surfaces, .models).
 * @param model  Logical model name; required for Tier 1 to look up the (account, model) pair.
 * @param now  Optional clock for deterministic tests.
 */
export function getRuntimeAvailability(node: RuntimeNode, model?: string, now: number | Date = Date.now()): RuntimeAvailability {
  if (!node || typeof node !== 'object') return 'unavailable';
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (node.tier === 'tier-1') {
    return getTier1Availability(node, model, nowMs);
  }
  return getLegacyAvailability(node, model, nowMs);
}

function getTier1Availability(node: RuntimeNode, model: string | undefined, nowMs: number): RuntimeAvailability {
  if (!model) return 'unobserved';
  const req = {
    model,
    protocol: node.protocol,
    surface: Array.isArray(node.surfaces) && node.surfaces.length > 0 ? node.surfaces[0] : 'chat_completions',
  };
  if (!isTier1Eligible(node, req, nowMs)) return 'unavailable';
  const perf = getTier1ModelPerf(node.id, model);
  if (!perf || perf.ttftEwma == null || perf.sampleCount === 0) return 'unobserved';
  if (perf.failureState === TIER1_FAILURE_STATES.HALF_OPEN) return 'unobserved';
  return 'available';
}

function getLegacyAvailability(node: RuntimeNode, model: string | undefined, nowMs: number): RuntimeAvailability {
  if (model && node.models && Object.keys(node.models).length > 0 && !node.models[model]) {
    return 'unavailable';
  }
  const status = peekAvailability(node.id, nowMs);
  if (status === 'no') return 'unavailable';
  if (status === 'probe') return 'unavailable';
  if (!hasBeenObserved(node.id)) return 'unobserved';
  return 'available';
}
