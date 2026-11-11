// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Pure failure/transition decisions. No module-level mutable runtime state.

import {
  FAILURE_STATE,
  TIER1_5XX_BASE_MS,
  TIER1_5XX_MAX_MS,
  TIER1_AUTH_DEFAULT_COOLDOWN_MS,
  TIER1_COOLDOWN_DEFAULT_MS,
  TIER1_COOLDOWN_MAX_MS,
  TIER1_TIMEOUT_BASE_MS,
  TIER1_TIMEOUT_MAX_MS,
  type Tier1FailureInput,
  type Tier1ModelRuntime,
  type Tier1Outcome,
} from './tier1-contract.ts';

export function classifyTier1Failure(classification: Tier1FailureInput, opts: { retryAfterMs?: number } = {}): Tier1Outcome {
  const { retryAfterMs } = opts;
  const kind = classification?.kind;
  if (kind === 'auth' && classification?.forbidden) {
    return {
      scope: 'model',
      action: 'cooldown',
      counted: false,
      backoff: 'forbidden',
      reason: kind,
      cooldownMs: Math.max(0, classification?.cooldownMs ?? TIER1_AUTH_DEFAULT_COOLDOWN_MS),
    };
  }
  if (kind === 'auth') {
    return {
      scope: 'account',
      action: 'disable',
      reason: kind,
      cooldownMs: Math.max(0, classification?.cooldownMs ?? TIER1_AUTH_DEFAULT_COOLDOWN_MS),
    };
  }
  if (kind === 'model_missing') {
    return {
      scope: 'upstream_model',
      action: 'cooldown',
      counted: false,
      cooldownMs: classification?.cooldownMs || 5_000,
      reason: kind,
    };
  }
  if (kind === 'endpoint_not_found') {
    return { scope: 'account', action: 'cooldown', counted: false, cooldownMs: classification?.cooldownMs || 5_000, reason: kind };
  }
  if (kind === 'rate_limit') {
    const explicit = retryAfterMs ?? classification?.retryAfterMs ?? 0;
    return {
      scope: classification?.rateLimitScope === 'model' ? 'model' : 'account',
      action: 'cooldown',
      counted: false,
      cooldownMs: explicit,
      backoff: 'rate_limit',
      reason: kind,
      scopeAmbiguous: !classification?.rateLimitScope,
      isQuota: classification?.rateLimitClass === 'quota',
    };
  }
  if (kind === 'client' || kind === 'client_abort') {
    return { scope: 'none', action: 'neutral', counted: false, cooldownMs: 0, reason: kind };
  }
  if (kind === 'headers_timeout' || kind === 'first_event_timeout' || kind === 'network' || kind === 'stream_interrupted') {
    return { scope: 'model', action: 'cooldown', counted: true, cooldownMs: 0, backoff: 'timeout', reason: kind };
  }
  if (kind === 'server') {
    return { scope: 'model', action: 'cooldown', counted: true, cooldownMs: 0, backoff: 'server', reason: kind };
  }
  if (kind === 'upstream_200_non_json_body' || kind === 'upstream_200_no_meaningful_output') {
    // A structurally broken 200 response keeps the documented short cooldown.
    // Without it the node is re-picked immediately and the broken upstream is
    // hammered again inside the same request.
    const short = Math.min(Math.max(0, classification?.cooldownMs ?? 0), TIER1_COOLDOWN_MAX_MS);
    return { scope: 'model', action: 'cooldown', counted: true, cooldownMs: short, backoff: 'default', reason: kind };
  }
  return { scope: 'model', action: 'cooldown', counted: true, cooldownMs: 0, backoff: 'default', reason: kind || 'unknown' };
}

function exponential(base: number, max: number, count: number): number {
  return Math.min(max, base * 2 ** Math.max(0, count - 1));
}


/** Jitter is supplied by the state facade; the cooldown decision is pure. */
export function modelCooldownMs(model: Tier1ModelRuntime, outcome: Tier1Outcome, jitter: (ms: number) => number): number {
  if (outcome.backoff === 'rate_limit') return Math.max(0, outcome.cooldownMs ?? 0);
  if ((outcome.cooldownMs ?? 0) > 0) {
    return Math.min(outcome.cooldownMs ?? 0, TIER1_COOLDOWN_MAX_MS);
  }
  if (outcome.backoff === 'timeout') return jitter(exponential(TIER1_TIMEOUT_BASE_MS, TIER1_TIMEOUT_MAX_MS, model.consecutiveFailures));
  if (outcome.backoff === 'server') return jitter(exponential(TIER1_5XX_BASE_MS, TIER1_5XX_MAX_MS, model.consecutiveFailures));
  return jitter(exponential(TIER1_COOLDOWN_DEFAULT_MS, TIER1_COOLDOWN_MAX_MS, model.consecutiveFailures));
}

export function rateLimitProbeBlocked(scope: { rateLimitRecoveryUntil: number }, scopeInFlight: number, now: number, v2: boolean): boolean {
  if (scope.rateLimitRecoveryUntil <= now) return false;
  if (!v2) return true;
  return scopeInFlight > 0;
}

export function shouldTransitionToHalfOpen(model: Tier1ModelRuntime | undefined, now: number): model is Tier1ModelRuntime {
  return model?.failureState === FAILURE_STATE.COOLDOWN && model.cooldownUntil <= now;
}
