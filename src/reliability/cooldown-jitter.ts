// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

export const COOLDOWN_JITTER_FACTOR = 0.1;

// Pure ±10% cooldown jitter primitive. The caller supplies the random sample so
// this helper owns only the arithmetic; policy still decides whether a duration
// is eligible for jitter. Explicit provider Retry-After values must bypass it.
export function jitterCooldownMs(cooldownMs: number, randomUnit: number): number {
  if (cooldownMs <= 0) return cooldownMs;
  const delta = cooldownMs * COOLDOWN_JITTER_FACTOR;
  return Math.round(cooldownMs + (randomUnit * 2 - 1) * delta);
}
