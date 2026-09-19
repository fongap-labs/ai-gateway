// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Tier 1 soft heat protection. This module owns both live in-flight pressure
// and short-lived provider-model 429 cohort evidence. Heat changes ranking and
// hedge admission only; it never makes a primary candidate ineligible.

import { tier1AccountInFlight } from './tier1-state.ts';
import type { RuntimeNode } from '../types/node.ts';

export const TIER1_INFLIGHT_MAX_FACTOR = 1.25;
export const TIER1_HEDGE_MAX_CONCURRENCY_PRESSURE = 0.75;

export const TIER1_PROVIDER_MODEL_429_WINDOW_MS = 90_000;
export const TIER1_PROVIDER_MODEL_429_MILD_ACCOUNTS = 3;
export const TIER1_PROVIDER_MODEL_429_STRONG_ACCOUNTS = 4;
export const TIER1_PROVIDER_MODEL_429_MILD_FACTOR = 1.15;
export const TIER1_PROVIDER_MODEL_429_STRONG_FACTOR = 1.35;

type Tier1ProviderModelRateLimitRuntime = {
  accounts: Map<string, number>,
};

const providerModelRateLimits = new Map<string, Tier1ProviderModelRateLimitRuntime>();

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function providerModelKey(provider: string, upstreamModel: string): string {
  return `${provider}\u0000${upstreamModel}`;
}

function pruneProviderModelRateLimits(provider: string, upstreamModel: string, now: number): Tier1ProviderModelRateLimitRuntime | null {
  const key = providerModelKey(provider, upstreamModel);
  const runtime = providerModelRateLimits.get(key);
  if (!runtime) return null;
  const cutoff = now - TIER1_PROVIDER_MODEL_429_WINDOW_MS;
  for (const [accountId, observedAt] of runtime.accounts) {
    if (observedAt <= cutoff) runtime.accounts.delete(accountId);
  }
  if (runtime.accounts.size === 0) {
    providerModelRateLimits.delete(key);
    return null;
  }
  return runtime;
}

export function recordTier1ProviderModelRateLimit(provider: string, upstreamModel: string, accountId: string, now: number = Date.now()): void {
  if (!provider || !upstreamModel || !accountId) return;
  const key = providerModelKey(provider, upstreamModel);
  const runtime = pruneProviderModelRateLimits(provider, upstreamModel, now)
    ?? { accounts: new Map<string, number>() };
  runtime.accounts.set(accountId, now);
  providerModelRateLimits.set(key, runtime);
}

export function recordTier1ProviderModelSuccess(provider: string, upstreamModel: string, accountId: string, now: number = Date.now()): void {
  const runtime = pruneProviderModelRateLimits(provider, upstreamModel, now);
  if (!runtime) return;

  // A real success is recovery evidence. Remove at most one independent 429
  // observation: preferably this same account, otherwise the oldest one.
  if (!runtime.accounts.delete(accountId)) {
    let oldestAccount: string | null = null;
    let oldestAt = Infinity;
    for (const [candidateId, observedAt] of runtime.accounts) {
      if (observedAt < oldestAt) {
        oldestAt = observedAt;
        oldestAccount = candidateId;
      }
    }
    if (oldestAccount) runtime.accounts.delete(oldestAccount);
  }
  if (runtime.accounts.size === 0) {
    providerModelRateLimits.delete(providerModelKey(provider, upstreamModel));
  }
}

export function tier1ProviderModelRateLimitCount(provider: string, upstreamModel: string, now: number = Date.now()): number {
  return pruneProviderModelRateLimits(provider, upstreamModel, now)?.accounts.size ?? 0;
}

export function tier1ProviderModelHeatFactor(provider: string, upstreamModel: string, now: number = Date.now()): number {
  const count = tier1ProviderModelRateLimitCount(provider, upstreamModel, now);
  if (count >= TIER1_PROVIDER_MODEL_429_STRONG_ACCOUNTS) return TIER1_PROVIDER_MODEL_429_STRONG_FACTOR;
  if (count >= TIER1_PROVIDER_MODEL_429_MILD_ACCOUNTS) return TIER1_PROVIDER_MODEL_429_MILD_FACTOR;
  return 1;
}

export function tier1ConcurrencyPressure(node: RuntimeNode): number {
  const inFlight = tier1AccountInFlight(node.id);
  if (!Number.isFinite(inFlight) || inFlight <= 0) return 0;
  // 1 -> .50, 2 -> .67, 3 -> .75, 4 -> .80. Ranking only.
  return clamp01(inFlight / (inFlight + 1));
}

export function tier1HeatPressure(node: RuntimeNode): number {
  return tier1ConcurrencyPressure(node);
}

export function tier1InFlightFactor(node: RuntimeNode): number {
  const pressure = tier1ConcurrencyPressure(node);
  return 1 + (TIER1_INFLIGHT_MAX_FACTOR - 1) * pressure;
}

export function tier1AffinityHeatFactor(node: RuntimeNode, baseAffinityFactor: number): number {
  if (!Number.isFinite(baseAffinityFactor) || baseAffinityFactor >= 1) return 1;
  const pressure = tier1HeatPressure(node);
  return baseAffinityFactor + (1 - baseAffinityFactor) * pressure;
}

export function tier1SelectionHeatFactor(node: RuntimeNode, baseAffinityFactor: number): number {
  return tier1InFlightFactor(node) * tier1AffinityHeatFactor(node, baseAffinityFactor);
}

export function tier1CanAcceptHedge(node: RuntimeNode): boolean {
  return tier1ConcurrencyPressure(node) < TIER1_HEDGE_MAX_CONCURRENCY_PRESSURE;
}

export function __resetTier1HeatForTests(): void {
  providerModelRateLimits.clear();
}
