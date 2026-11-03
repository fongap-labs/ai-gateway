// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

export const COOLDOWN_JITTER_FACTOR = 0.1;

// Apply jitter only to calculated delays, never provider Retry-After.
export function jitterCooldownMs(cooldownMs: number, randomUnit: number): number {
  if (cooldownMs <= 0) return cooldownMs;
  const delta = cooldownMs * COOLDOWN_JITTER_FACTOR;
  return Math.round(cooldownMs + (randomUnit * 2 - 1) * delta);
}
