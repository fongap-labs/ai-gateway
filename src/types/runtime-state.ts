// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Unified runtime-state read contracts.
//
// The gateway keeps two isolate-local runtime-state backends by design: the
// Tier 1 adaptive runtime (reliability/tier1-state.ts) and the Tier 2/3 node
// state (reliability/node-state.ts). They learn different signals on purpose
// and are NOT unified into one implementation. Upper layers that need to READ
// state consume this one contract through RuntimeStateStore projections, so
// new consumers never import backend internals directly.
//
// Contracts are honest about what a backend actually tracks: a field the
// backend does not own is `null`, never a fabricated value. This module is a
// neutral cross-layer contract only (types/ is not a utility drawer).

export type RuntimeAvailability = 'available' | 'cooling' | 'probing' | 'unavailable';

/** Per-endpoint (per-node) runtime state view. */
export type EndpointState = Readonly<{
  availability: RuntimeAvailability,
  inFlight: number,
  cooldownRemainingMs: number,
  cooldownReason: string | null,
  circuit: 'closed' | 'half_open' | 'open' | null,
  /** Numeric health score when the backend tracks one, else null. */
  health: number | null,
  ttftEwmaMs: number | null,
  latencyEwmaMs: number | null,
  lastUsedAt: number,
}>;

/** Per-(node, logical-model) runtime state view. `null` when the backend has
 *  no entry for the pair (never observed / not served). */
export type ModelState = Readonly<{
  supported: boolean,
  cooldownRemainingMs: number,
  failureState: string,
  ttftEwmaMs: number | null,
  latencyEwmaMs: number | null,
  sampleCount: number,
}>;

/** Quota window view over the directive vocabulary: unknown / healthy /
 *  near_limit / exhausted. `unknown` means the provider reports no quota and
 *  the reactive adaptive-429 + cooldown path governs admission. */
export type QuotaRuntimeState = Readonly<{
  state: 'unknown' | 'healthy' | 'near_limit' | 'exhausted',
  resetAtMs: number,
  remainingRequests: number | null,
  remainingTokens: number | null,
  source: string | null,
}>;

/** Per-account (credential/key-slot) runtime state view. Tier 2/3 nodes are
 *  their own account identity; auth-disabled and quota windows are Tier 1
 *  subscription/adaptive concepts and surface as neutral defaults there. */
export type AccountState = Readonly<{
  disabled: boolean,
  cooldownRemainingMs: number,
  quota: QuotaRuntimeState,
  inFlight: number,
}>;

/** The single read interface over both runtime-state backends. Read-only:
 *  claims, releases, outcome recording, and quota settlement stay owned by
 *  the backend modules and the request dispatch funnels. */
export interface RuntimeStateStore {
  endpoint(nodeId: string, now?: number): EndpointState;
  account(nodeId: string, now?: number): AccountState;
  model(nodeId: string, modelId: string, now?: number): ModelState | null;
}
