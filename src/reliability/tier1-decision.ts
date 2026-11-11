// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { RUNTIME_TUNABLES } from '../config/runtime-vars.ts';
import {
  TIER1_COOLDOWN_MAX_MS,
  type Tier1FailureInput,
  type Tier1Outcome,
} from './tier1-definitions.ts';

const TIER1_AUTH_DEFAULT_COOLDOWN_MS = RUNTIME_TUNABLES.find((entry) => entry.name === 'AIG_AUTH_FAILURE_COOLDOWN_MS')?.def ?? 0;

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

