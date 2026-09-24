// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Dispatch-time credential resolution for Tier 2 subscription nodes.
//
// Resolution order (per node, per isolate):
//   1. Isolate-local cache, if the token has more than REFRESH_MARGIN_MS of
//      life remaining — the scheduling hot path never touches D1 here.
//   2. D1 load (cache miss): decrypt + cache when the token is still fresh.
//   3. Refresh: when the cached/stored token is inside the margin, exchange
//      the refresh token at the provider's token endpoint and persist the
//      rotated credential with a compare-and-swap on refresh_version.
//
// Refresh-token rotation safety:
//   - Isolate-level singleflight: concurrent requests for one node share a
//     single refresh Promise, so one isolate never issues parallel refreshes.
//   - Cross-isolate compare-and-swap: the D1 persist only lands when the
//     stored refresh_version still matches; a losing writer reloads the
//     winner's credential instead of clobbering it, so exactly one refresh
//     token survives as the persisted authority.
//
// Failure modes are all fail-closed: the resolver returns ok:false and the
// dispatch layer rotates the attempt to another node. A subscription node
// never receives traffic with a missing or stale credential.

import { getOAuthProvider } from './provider-configs.ts';
import { loadSubscriptionToken, persistRefreshedToken, markTokenStatus } from './token-store.ts';
import type { StoredSubscriptionToken } from './token-store.ts';
import type { RuntimeNode } from '../types/node.ts';

type CacheEntry = { token: string, expiresAt: number, accountId: string | null };
const isolateCache = new Map<string, CacheEntry>();

export type ResolveFailureReason = 'unconfigured_provider' | 'adapter_missing' | 'no_token' | 'refresh_failed' | 'store_unavailable';

// Negative cache: a failed refresh is remembered for this long so concurrent
// requests do not hammer the provider's token endpoint when a subscription
// credential is unusable (refresh rejected / token revoked).
export const RESOLUTION_FAILURE_TTL_MS = 60 * 1000;
const resolutionFailures = new Map<string, { until: number, reason: ResolveFailureReason }>();

// Refresh when the access token has less than this much life left, so an
// in-flight request is unlikely to send a token that expires mid-stream.
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Isolate-level singleflight: one in-flight resolution per node. Concurrent
// requests await the same Promise instead of issuing parallel refreshes.
const inFlightResolutions = new Map<string, Promise<ResolveResult>>();

export type ResolveResult =
  | { ok: true, token: string, accountId: string | null }
  | { ok: false, reason: ResolveFailureReason };

// PKCE token refresh against the provider's token endpoint. Never logs token
// material; failures carry only a reason string.
async function refreshAccessToken(
  env: Record<string, unknown>,
  provider: string,
  refreshToken: string,
): Promise<{ ok: true, token: string, expiresInSec: number, refreshToken: string | null } | { ok: false }> {
  const providerConfig = getOAuthProvider(env, provider);
  if (!providerConfig) return { ok: false };
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: providerConfig.clientId,
  };
  if (providerConfig.clientSecret) params.client_secret = providerConfig.clientSecret;
  let response: Response;
  try {
    response = await fetch(providerConfig.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };
  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    return { ok: false };
  }
  const token = typeof payload.access_token === 'string' ? payload.access_token : null;
  if (!token) return { ok: false };
  const expiresInSec = typeof payload.expires_in === 'number' ? payload.expires_in
    : (typeof payload.expires_in === 'string' && /^\d+$/.test(payload.expires_in) ? Number(payload.expires_in) : 3600);
  const rotatedRefresh = typeof payload.refresh_token === 'string' ? payload.refresh_token : null;
  return { ok: true, token, expiresInSec, refreshToken: rotatedRefresh };
}

function cacheToken(nodeId: string, token: string, expiresAt: number, accountId: string | null): void {
  isolateCache.set(nodeId, { token, expiresAt, accountId });
}

// Single resolution pass without the singleflight wrapper.
async function resolveOnce(
  env: Record<string, unknown>,
  node: RuntimeNode,
): Promise<ResolveResult> {
  const now = Date.now();
  const cached = isolateCache.get(node.id);
  if (cached && cached.expiresAt > now + REFRESH_MARGIN_MS) {
    return { ok: true, token: cached.token, accountId: cached.accountId };
  }

  const providerConfig = getOAuthProvider(env, node.provider);
  if (!providerConfig) return { ok: false, reason: 'unconfigured_provider' };
  if (providerConfig.dispatchReady === false) {
    // OAuth onboarding may have succeeded, but no verified subscription
    // backend (endpoint + request shape + entitlement semantics) exists for
    // this provider behind the OpenAI-compatible profile. Dispatch fails
    // closed rather than pretending the entitlement is consumable.
    resolutionFailures.set(node.id, { until: now + RESOLUTION_FAILURE_TTL_MS, reason: 'adapter_missing' });
    return { ok: false, reason: 'adapter_missing' };
  }

  let stored: StoredSubscriptionToken | null = null;
  try {
    stored = await loadSubscriptionToken(env, node.id);
  } catch {
    stored = null;
  }
  if (!stored) {
    resolutionFailures.set(node.id, { until: now + RESOLUTION_FAILURE_TTL_MS, reason: 'no_token' });
    return { ok: false, reason: 'no_token' };
  }

  if (stored.expiresAt > now + REFRESH_MARGIN_MS) {
    cacheToken(node.id, stored.accessToken, stored.expiresAt, stored.accountId);
    return { ok: true, token: stored.accessToken, accountId: stored.accountId };
  }

  if (!stored.refreshToken) {
    await markTokenStatus(env, node.id, 'expired').catch(() => {});
    resolutionFailures.set(node.id, { until: now + RESOLUTION_FAILURE_TTL_MS, reason: 'no_token' });
    return { ok: false, reason: 'no_token' };
  }

  const refreshed = await refreshAccessToken(env, node.provider, stored.refreshToken);
  if (!refreshed.ok) {
    await markTokenStatus(env, node.id, 'refresh_failed').catch(() => {});
    resolutionFailures.set(node.id, { until: now + RESOLUTION_FAILURE_TTL_MS, reason: 'refresh_failed' });
    return { ok: false, reason: 'refresh_failed' };
  }
  const expiresAt = now + refreshed.expiresInSec * 1000;
  const nextRefreshToken = refreshed.refreshToken ?? stored.refreshToken;

  // Compare-and-swap persist. A lost CAS means another isolate (or a
  // completed singleflight peer) rotated first; reload the winner's state
  // and serve it instead of clobbering with a stale refresh token.
  const persisted = await persistRefreshedToken(env, {
    nodeId: node.id,
    accessToken: refreshed.token,
    refreshToken: nextRefreshToken,
    expiresAt,
    expectedVersion: stored.refreshVersion,
  });
  if (!persisted) {
    const winner = await loadSubscriptionToken(env, node.id);
    if (winner && winner.expiresAt > now + REFRESH_MARGIN_MS) {
      cacheToken(node.id, winner.accessToken, winner.expiresAt, winner.accountId);
      return { ok: true, token: winner.accessToken, accountId: winner.accountId };
    }
    return { ok: false, reason: 'store_unavailable' };
  }
  cacheToken(node.id, refreshed.token, expiresAt, stored.accountId);
  return { ok: true, token: refreshed.token, accountId: stored.accountId };
}

// Resolve the access token for a subscription node. Cache-first; the
// negative cache answers immediately for recently failed nodes; the
// singleflight map collapses concurrent resolutions of one node into one
// refresh.
export function resolveSubscriptionCredential(
  env: Record<string, unknown>,
  node: RuntimeNode,
): Promise<ResolveResult> {
  if (!node.auth || node.auth !== 'oauth') {
    return Promise.resolve({ ok: false, reason: 'unconfigured_provider' });
  }
  const now = Date.now();
  const recentFailure = resolutionFailures.get(node.id);
  if (recentFailure) {
    if (recentFailure.until > now) {
      return Promise.resolve({ ok: false, reason: recentFailure.reason });
    }
    resolutionFailures.delete(node.id);
  }
  const inFlight = inFlightResolutions.get(node.id);
  if (inFlight) return inFlight;
  const attempt = resolveOnce(env, node).finally(() => {
    inFlightResolutions.delete(node.id);
  });
  inFlightResolutions.set(node.id, attempt);
  return attempt;
}

export function __resetSubscriptionCacheForTests(): void {
  isolateCache.clear();
  resolutionFailures.clear();
  inFlightResolutions.clear();
}
