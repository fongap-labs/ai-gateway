// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Provider-agnostic adaptive 429 cooldown for Tier 1 credentials.
//
// Scope is (provider, key-slot), never provider-only. A 429 blamed on one model
// keeps its own ladder per model, so a limited model does not push the key's
// other models up the ladder; a 429 blamed on the whole account uses the
// key-slot ladder. Runtime node ids are the non-secret identity of one
// configured credential/key; raw API keys are never stored or logged here.
//
// Escalation happens only when a 429 arrives after the previous cooldown has
// expired (normally the controlled recovery request). Extra 429 responses from
// requests that were already in flight during the same cooldown do NOT advance
// or extend the local ladder, preventing one burst from jumping straight to a
// long block. An explicit upstream Retry-After may still extend the deadline.
//
// A provider's own Retry-After is trusted for the first
// ADAPTIVE_429_TRUSTED_HINT_STAGES failures (the provider knows its window better
// than a blind ladder does); from then on it only raises the ladder floor, so a
// provider that keeps advertising "1s" while staying exhausted still backs off.

// Top step is 30 minutes: a key that recovers is back in the pool within half an
// hour at worst, while a long outage still costs only about one probe per 30 minutes.
export const ADAPTIVE_429_COOLDOWN_STEPS_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000] as const);

// A 429 that hit a short per-minute style window (rpm/tpm/rate-limit wording, or
// an explicit wait hint of a minute or less) clears as soon as the window rolls
// over, so this ladder escalates gently and tops out at 5 minutes — a long block
// here would only waste the provider's free capacity.
export const ADAPTIVE_429_WINDOW_STEPS_MS = Object.freeze([15_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 300_000] as const);

// A 429 that names a long-lived allowance (an hourly plan window, a daily cap) stays
// exhausted until the provider's window rolls over, which can be hours away. Probing
// such a key every few minutes buys nothing but a failed request each time, so this
// ladder starts at the 5-minute stage and keeps stretching to the longest window
// seen in practice (5 hours). Any success clears it, so a key whose window rolled
// over early is back in the pool at the next probe.
export const ADAPTIVE_429_QUOTA_STEPS_MS = Object.freeze([
  300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 7_200_000, 10_800_000, 18_000_000,
] as const);

export const ADAPTIVE_429_TRUSTED_HINT_STAGES = 2;
// A 429 whose text names a long-lived allowance (daily limit, plan window, credits)
// will not clear in 15 seconds, so the ladder starts here (5 minutes on the default
// ladder) instead of spending probes on the short steps.
export const ADAPTIVE_429_QUOTA_START_STAGE = 5;

const STEP_MIN_MS = 1_000;
const STEP_MAX_MS = 24 * 3_600_000;
const STEP_MAX_COUNT = 12;

/**
 * Ladder from AIG_RATE_LIMIT_STEPS_MS (or the caller's fallback ladder), a comma
 * separated list of milliseconds such as "15000,30000,60000,300000". Unset or
 * invalid input keeps the given fallback ladder; the gateway never fails to start
 * over a typo here.
 */
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

/**
 * Returns the cooldown to apply for this 429.
 *
 * retryAfterMs is the provider's own hint. It is used as-is for the first
 * ADAPTIVE_429_TRUSTED_HINT_STAGES failures and afterwards only raises the
 * ladder floor. `modelId` selects the per-model ladder (omit it for the
 * account-wide ladder); `steps` overrides the default ladder.
 */
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
    // Same cooldown window: this is usually an already-in-flight sibling
    // request finishing late. Do not increase the stage and do not restart
    // the local timer. Only an explicit provider Retry-After may push the
    // existing deadline farther out.
    if (explicit > 0) state.cooldownUntil = Math.max(state.cooldownUntil, now + explicit);
    state.last429At = now;
    states.set(key, state);
    return Math.max(1, state.cooldownUntil - now);
  }

  // The account-wide ladder inherits the highest stage any model ladder of
  // this key has reached, but ONLY when the caller is already starting at
  // an elevated stage (quota-classified 429 with QUOTA_START_STAGE=5).
  // This prevents a key that was quota-exhausted, recovered, then exhausted
  // again from resetting to stage 1, while keeping window-classified ladders
  // independent as the existing tests expect.
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

/** Clear only after a real recovery request succeeds. */
export function clearAdaptive429State(provider: string, keyId: string, modelId: string = ''): void {
  states.delete(scopeKey(provider, keyId, modelId));
  // A recovery resets the ladder for this key, whatever scope it recovered on:
  // keeping the highest stage any model ladder reached would let a later
  // quota-classified 429 inherit a stale stage and start far above the
  // documented quota start stage.
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
