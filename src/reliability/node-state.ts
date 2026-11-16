import type { NodeState } from '../types/reliability.ts';
import { cryptoRng } from '../utils/crypto-rng.ts';
import { jitterCooldownMs } from './cooldown-jitter.ts';

export const CIRCUIT_FAILURE_THRESHOLD = 3;
export const CIRCUIT_OPEN_MS = 30_000;

const HEALTH_INITIAL = 50;
const HEALTH_MIN = 1;
const HEALTH_MAX = 100;
const HEALTH_SUCCESS_GAIN = 3;
const HEALTH_COOLDOWN_RECOVERY = 10;
const LATENCY_EWMA_ALPHA = 0.3;
const PROBE_EWMA_ALPHA = 0.15;
const MAX_STATE_ENTRIES = 256;
const CLEANUP_INTERVAL_MS = 30_000;
const STALE_FAILURE_MS = 300_000;
const MODEL_MISSING_COOLDOWN_MS = 5_000;
const MODEL_PERF_MAX = 16;

const nodeState = new Map<string, NodeState>();
let lastCleanup = 0;

function createState(): NodeState {
  return {
    activeRequests: 0,
    healthScore: HEALTH_INITIAL,
    avgLatencyMs: 0,
    avgTtftMs: 0,
    cooldownUntil: 0,
    cooldownReason: null,
    circuitState: 'closed',
    consecutiveFailures: 0,
    lastTransientFailureAt: 0,
    probeInFlight: false,
    totalRequests: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    lastUsedAt: 0,
    modelCooldowns: new Map(),
    modelPerf: new Map(),
  };
}

export function getNodeState(nodeId: string): NodeState {
  let s = nodeState.get(nodeId);
  if (!s) {
    s = createState();
    nodeState.set(nodeId, s);
  }
  return s;
}

export function peekAvailability(nodeId: string, now: number = Date.now()): 'yes' | 'probe' | 'no' {
  const s = getNodeState(nodeId);
  if (s.cooldownUntil > now) return 'no';
  if (s.circuitState === 'closed') return 'yes';
  if (s.circuitState === 'open') return s.cooldownUntil <= now ? 'probe' : 'no';
  return s.probeInFlight ? 'no' : 'probe';
}

export function acquireSlot(nodeId: string, now: number = Date.now()): boolean {
  const s = getNodeState(nodeId);
  if (peekAvailability(nodeId, now) === 'no') return false;
  if (s.circuitState === 'open' && s.cooldownUntil <= now) {
    s.circuitState = 'half-open';
    s.probeInFlight = true;
  } else if (s.circuitState === 'half-open' && !s.probeInFlight) {
    s.probeInFlight = true;
  }
  s.activeRequests++;
  s.totalRequests++;
  s.lastUsedAt = now;
  maybeCleanup(now);
  return true;
}

export function recordSuccess(nodeId: string, latencyMs: number, model: string, now: number = Date.now()): void {
  const s = releaseAndReturn(nodeId);
  s.totalSuccesses++;
  s.lastTransientFailureAt = 0;
  s.healthScore = Math.min(HEALTH_MAX, s.healthScore + HEALTH_SUCCESS_GAIN);
  s.consecutiveFailures = 0;
  s.avgLatencyMs =
    s.avgLatencyMs === 0 || typeof latencyMs !== 'number'
      ? Math.max(0, latencyMs || 0)
      : s.avgLatencyMs * (1 - LATENCY_EWMA_ALPHA) + latencyMs * LATENCY_EWMA_ALPHA;
  if (model) updateModelPerf(s, model, { latencyMs }, now);
  recoverFromHalfOpen(s);
}

export function recordTtft(nodeId: string, ttftMs: number, model: string, { source = 'passive' }: { source?: string } = {}): void {
  const s = getNodeState(nodeId);
  const alpha = source === 'probe' ? PROBE_EWMA_ALPHA : LATENCY_EWMA_ALPHA;
  s.avgTtftMs = s.avgTtftMs === 0 || typeof ttftMs !== 'number' || ttftMs < 0 ? Math.max(0, ttftMs || 0) : s.avgTtftMs * (1 - alpha) + ttftMs * alpha;
  if (model) updateModelPerf(s, model, { ttftMs, source });
}

export function getModelPerf(nodeId: string, model: string) {
  const s = nodeState.get(nodeId);
  return s?.modelPerf?.get(model) || null;
}

function updateModelPerf(
  s: NodeState,
  model: string,
  opts: { ttftMs?: number; latencyMs?: number; source?: string } = {},
  now: number = Date.now(),
): void {
  const { ttftMs, latencyMs, source = 'passive' } = opts;
  let entry = s.modelPerf.get(model);
  if (!entry) {
    if (s.modelPerf.size >= MODEL_PERF_MAX) {
      let oldest: number | null = null,
        oldestKey: string | null = null;
      for (const [k, v] of s.modelPerf) {
        if (!oldest || v.lastUsedAt < oldest) {
          oldest = v.lastUsedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) s.modelPerf.delete(oldestKey);
    }
    entry = {
      avgTtftMs: 0,
      avgLatencyMs: 0,
      lastUsedAt: now,
      ttftSamples: 0,
      passiveSamples: 0,
      probeSamples: 0,
      lastTtftAt: 0,
      lastProbeFailureAt: 0,
    };
    s.modelPerf.set(model, entry);
  }
  entry.lastUsedAt = now;
  if (typeof ttftMs === 'number' && ttftMs >= 0) {
    const alpha = source === 'probe' ? PROBE_EWMA_ALPHA : LATENCY_EWMA_ALPHA;
    entry.lastTtftAt = now;
    entry.ttftSamples++;
    if (source === 'probe') entry.probeSamples++;
    else entry.passiveSamples++;
    entry.avgTtftMs = entry.avgTtftMs === 0 ? ttftMs : entry.avgTtftMs * (1 - alpha) + ttftMs * alpha;
  }
  if (typeof latencyMs === 'number' && latencyMs >= 0) {
    entry.avgLatencyMs = entry.avgLatencyMs === 0 ? latencyMs : entry.avgLatencyMs * (1 - LATENCY_EWMA_ALPHA) + latencyMs * LATENCY_EWMA_ALPHA;
  }
}

export function markProbeFailure(nodeId: string, model: string, now: number = Date.now()): void {
  const s = getNodeState(nodeId);
  const entry = s.modelPerf.get(model);
  if (!entry) return;
  entry.lastProbeFailureAt = now;
}

export function recordFailure(
  nodeId: string,
  {
    counted = false,
    cooldownMs = 0,
    reason = null,
    explicitRetryAfter = false,
  }: { counted?: boolean; cooldownMs?: number; reason?: string | null; explicitRetryAfter?: boolean } = {},
  now: number = Date.now(),
): void {
  const s = releaseAndReturn(nodeId);
  s.totalFailures++;
  if (cooldownMs > 0) {
    const effectiveCooldown = explicitRetryAfter ? cooldownMs : jitterCooldownMs(cooldownMs, cryptoRng());
    s.cooldownUntil = now + effectiveCooldown;
    s.cooldownReason = reason;
  }
  s.consecutiveFailures = counted ? s.consecutiveFailures + 1 : 0;
  if (counted) s.lastTransientFailureAt = now;

  if (!counted) {
    recoverFromHalfOpen(s);
    return;
  }

  if (s.circuitState === 'half-open') {
    openCircuit(s, now);
    return;
  }
  if (s.circuitState === 'closed' && s.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    openCircuit(s, now);
  }
}

export function recordNeutralEnd(nodeId: string): void {
  const s = releaseAndReturn(nodeId);
  recoverFromHalfOpen(s);
}

export function recordModelMissing(nodeId: string, model: string, cooldownMs: number = MODEL_MISSING_COOLDOWN_MS, now: number = Date.now()): void {
  const s = releaseAndReturn(nodeId);
  if (cooldownMs > 0) {
    s.modelCooldowns.set(model, now + cooldownMs);
  }
  recoverFromHalfOpen(s);
}

export function isModelCooling(nodeId: string, model: string, now: number = Date.now()): boolean {
  const s = nodeState.get(nodeId);
  if (!s?.modelCooldowns?.size) return false;
  const until = s.modelCooldowns.get(model);
  return until ? until > now : false;
}

export function getModelCooldownRemainingMs(nodeId: string, model: string, now: number = Date.now()): number {
  const s = nodeState.get(nodeId);
  if (!s?.modelCooldowns?.size) return 0;
  const until = s.modelCooldowns.get(model);
  return until && until > now ? until - now : 0;
}

function releaseAndReturn(nodeId: string): NodeState {
  const s = getNodeState(nodeId);
  s.activeRequests = Math.max(0, s.activeRequests - 1);
  return s;
}

function openCircuit(s: NodeState, now: number): void {
  s.circuitState = 'open';
  s.probeInFlight = false;
  s.cooldownUntil = now + CIRCUIT_OPEN_MS;
  s.cooldownReason = `circuit_open_after_${CIRCUIT_FAILURE_THRESHOLD}_failures`;
}

function recoverFromHalfOpen(s: NodeState): void {
  if (s.circuitState === 'half-open' || s.probeInFlight) {
    s.circuitState = 'closed';
    s.probeInFlight = false;
    s.consecutiveFailures = 0;
  }
}

const PENALTY: Record<string, number> = {
  rate_limit: 10,
  auth: 30,
  server: 20,
  network: 12,
  stream: 12,
  client: 0,
};

export function applyHealthPenalty(nodeId: string, kind: string): void {
  const s = getNodeState(nodeId);
  const amount = PENALTY[kind] ?? 8;
  s.healthScore = Math.max(HEALTH_MIN, s.healthScore - amount);
}

export function bumpNodeCounters(
  nodeId: string,
  { requests = 0, successes = 0, failures = 0 }: { requests?: number; successes?: number; failures?: number } = {},
  now: number = Date.now(),
): void {
  const s = getNodeState(nodeId);
  if (requests) {
    s.totalRequests += requests;
    s.lastUsedAt = now;
  }
  if (successes) s.totalSuccesses += successes;
  if (failures) s.totalFailures += failures;
}

function maybeCleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [, s] of nodeState) {
    if (s.cooldownUntil > 0 && s.cooldownUntil <= now) {
      s.cooldownUntil = 0;
      s.cooldownReason = null;
      s.healthScore = Math.min(HEALTH_MAX, s.healthScore + HEALTH_COOLDOWN_RECOVERY);
    }
    if (s.modelCooldowns?.size) {
      for (const [model, until] of s.modelCooldowns) {
        if (until <= now) s.modelCooldowns.delete(model);
      }
    }
    if (s.activeRequests === 0 && s.consecutiveFailures > 0 && now - s.lastUsedAt > STALE_FAILURE_MS) {
      s.consecutiveFailures = 0;
    }
  }
  if (nodeState.size > MAX_STATE_ENTRIES) {
    const entries = [...nodeState.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const target = Math.floor(MAX_STATE_ENTRIES * 0.75);
    const excess = nodeState.size - target;
    let deleted = 0;
    for (let i = 0; i < entries.length && deleted < excess; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const [, s] = entry;
      if (s.activeRequests > 0 || s.probeInFlight) continue;
      nodeState.delete(entry[0]);
      deleted++;
    }
  }
}

export function getCooldownRemainingMs(nodeId: string, now: number = Date.now()): number {
  const s = getNodeState(nodeId);
  return s.cooldownUntil > now ? s.cooldownUntil - now : 0;
}

export function snapshotNode(nodeId: string, now: number = Date.now()) {
  const s = getNodeState(nodeId);
  const cooling = s.cooldownUntil > now;
  return {
    health_score: Math.round(s.healthScore),
    status: cooling ? 'cooling_down' : 'active',
    cooldown_remaining_ms: cooling ? s.cooldownUntil - now : 0,
    cooldown_reason: cooling ? s.cooldownReason : null,
    circuit_state: s.circuitState,
    active_requests: s.activeRequests,
    consecutive_failures: s.consecutiveFailures,
    avg_latency_ms: Math.round(s.avgLatencyMs),
    avg_ttft_ms: Math.round(s.avgTtftMs),
    total_requests: s.totalRequests,
    total_successes: s.totalSuccesses,
    total_failures: s.totalFailures,
    last_used_at: s.lastUsedAt > 0 ? new Date(s.lastUsedAt).toISOString() : null,
  };
}

export function hasBeenObserved(nodeId: string): boolean {
  const s = nodeState.get(nodeId);
  return Boolean(s && s.totalSuccesses > 0);
}

export function __resetAllStateForTests(): void {
  nodeState.clear();
  lastCleanup = 0;
}
