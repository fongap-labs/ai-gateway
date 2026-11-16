export const ADAPTIVE_429_COOLDOWN_STEPS_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000] as const);

export const ADAPTIVE_429_WINDOW_STEPS_MS = Object.freeze([15_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 300_000] as const);

export const ADAPTIVE_429_QUOTA_STEPS_MS = Object.freeze([300_000, 600_000, 1_200_000, 1_800_000] as const);

export const TIER1_QUOTA_COOLDOWN_MAX_MS = 1_800_000;

export const ADAPTIVE_429_TRUSTED_HINT_STAGES = 2;
export const ADAPTIVE_429_QUOTA_START_STAGE = 5;

const STEP_MIN_MS = 1_000;
const STEP_MAX_MS = 24 * 3_600_000;
const STEP_MAX_COUNT = 12;

export function adaptive429StepsFromEnv(raw: unknown, fallback: readonly number[] = ADAPTIVE_429_COOLDOWN_STEPS_MS): readonly number[] {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const steps = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= STEP_MIN_MS && value <= STEP_MAX_MS)
    .map((value) => Math.round(value));
  const parsed = raw.split(',').length;
  if (steps.length === 0 || steps.length !== parsed || steps.length > STEP_MAX_COUNT) return fallback;
  return Object.freeze(steps);
}

const MAX_ENTRIES = 512;

type Adaptive429State = {
  stage: number;
  cooldownUntil: number;
  last429At: number;
};

const states = new Map<string, Adaptive429State>();
const maxModelStage = new Map<string, number>();

function scopeKey(provider: string, keyId: string, modelId: string = ''): string {
  return `${String(provider || '')
    .trim()
    .toLowerCase()}\u0000${String(keyId || '').trim()}\u0000${String(modelId || '').trim()}`;
}

function accountKey(provider: string, keyId: string): string {
  return `${String(provider || '')
    .trim()
    .toLowerCase()}\u0000${String(keyId || '').trim()}`;
}

function getMaxModelStageForKey(provider: string, keyId: string): number {
  return maxModelStage.get(accountKey(provider, keyId)) ?? 0;
}

function updateMaxModelStageForKey(provider: string, keyId: string, stage: number): void {
  const key = accountKey(provider, keyId);
  const current = maxModelStage.get(key) ?? 0;
  if (stage > current) maxModelStage.set(key, stage);
}

function clearMaxModelStageForKey(provider: string, keyId: string): void {
  maxModelStage.delete(accountKey(provider, keyId));
}

function automaticCooldownMs(stage: number, steps: readonly number[]): number {
  const index = Math.min(Math.max(0, stage - 1), steps.length - 1);
  return steps[index] ?? steps[0] ?? ADAPTIVE_429_COOLDOWN_STEPS_MS[0];
}

function pruneIfNeeded(): void {
  if (states.size <= MAX_ENTRIES) return;
  const entries = [...states.entries()].sort((a, b) => a[1].last429At - b[1].last429At);
  const remove = states.size - Math.floor(MAX_ENTRIES * 0.75);
  for (let i = 0; i < remove; i++) {
    const entry = entries[i];
    if (entry) states.delete(entry[0]);
  }
}

export function nextAdaptive429CooldownMs(
  provider: string,
  keyId: string,
  retryAfterMs: number = 0,
  now: number = Date.now(),
  modelId: string = '',
  steps: readonly number[] = ADAPTIVE_429_COOLDOWN_STEPS_MS,
  startStage: number = 1,
): number {
  const key = scopeKey(provider, keyId, modelId);
  const explicit = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.round(retryAfterMs) : 0;
  let state = states.get(key);

  if (state && state.cooldownUntil > now) {
    if (explicit > 0) state.cooldownUntil = Math.max(state.cooldownUntil, now + explicit);
    state.last429At = now;
    states.set(key, state);
    return Math.max(1, state.cooldownUntil - now);
  }

  const shouldInherit = modelId === '' && startStage > 1;
  const inheritedMaxModelStage = shouldInherit ? getMaxModelStageForKey(provider, keyId) : 0;
  const firstStage = Math.min(Math.max(1, Math.trunc(startStage) || 1, inheritedMaxModelStage || 1), steps.length);
  if (!state) {
    state = { stage: firstStage, cooldownUntil: 0, last429At: now };
  } else {
    state.stage = Math.min(Math.max(state.stage + 1, firstStage), steps.length);
  }

  const adaptive = automaticCooldownMs(state.stage, steps);
  const trustHint = explicit > 0 && state.stage <= ADAPTIVE_429_TRUSTED_HINT_STAGES;
  state.cooldownUntil = now + (trustHint ? explicit : Math.max(adaptive, explicit));
  state.last429At = now;
  states.set(key, state);
  if (modelId !== '') updateMaxModelStageForKey(provider, keyId, state.stage);
  pruneIfNeeded();

  return Math.max(1, state.cooldownUntil - now);
}

export function clearAdaptive429State(provider: string, keyId: string, modelId: string = ''): void {
  states.delete(scopeKey(provider, keyId, modelId));
  clearMaxModelStageForKey(provider, keyId);
}

export function snapshotAdaptive429State(provider: string, keyId: string, now: number = Date.now(), modelId: string = '') {
  const state = states.get(scopeKey(provider, keyId, modelId));
  if (!state) return { stage: 0, cooldown_remaining_ms: 0 };
  return {
    stage: state.stage,
    cooldown_remaining_ms: Math.max(0, state.cooldownUntil - now),
  };
}

export function __resetAdaptive429StateForTests(): void {
  states.clear();
}
