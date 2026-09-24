// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Dispatch-time credential resolution for Tier 2 subscription nodes.
//
// Resolution order (per node, per isolate):
//   1. Isolate-local cache, if the token has more than REFRESH_MARGIN_MS of
//      life remaining - the scheduling hot path never touches D1 here.
//   2. D1 load (cache miss): decrypt + cache when the token is still fresh.
//   3. Refresh: when the cached/stored token is inside the margin, exchange
//      the refresh token at the provider's token endpoint, persist and cache
//      the new access token.
//
// Failure modes are all fail-closed: the resolver returns ok:false and the
// dispatch layer rotates the attempt to another node. A subscription node
// never receives traffic with a missing or stale credential.

import { getOAuthProvider } from './provider-configs.ts';
import { loadSubscriptionToken, storeSubscriptionToken, markTokenStatus } from './token-store.ts';
import type { StoredSubscriptionToken } from './token-store.ts';
import type { RuntimeNode } from '../types/node.ts';

// Refresh when the access token has less than this much life left, so an
// in-flight request is unlikely to send a token that expires mid-stream.
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type CacheEntry = { token: string, expiresAt: number };
const isolateCache = new Map<string, CacheEntry>();

export type ResolveFailureReason = 'unconfigured_provider' | 'no_token' | 'refresh_failed' | 'store_unavailable';

// Negative cache: a failed refresh is remembered for this long so concurrent
// requests do not hammer the provider's token endpoint when a subscription
// credential is unusable (refresh rejected / token revoked).
export const RESOLUTION_FAILURE_TTL_MS = 60 * 1000;
const resolutionFailures = new Map<string, { until: number, reason: ResolveFailureReason }>();

export type ResolveResult =
  | { ok: true, token: string }
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
  let response: Response;
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: providerConfig.clientId,
  };
  if (providerConfig.clientSecret) params.client_secret = providerConfig.clientSecret;
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

async function persistAndCache(
  env: Record<string, unknown>,
  nodeId: string,
  token: string,
  expiresAt: number,
): Promise<boolean> {
  isolateCache.set(nodeId, { token, expiresAt });
  return true;
}

// Resolve the access token for a subscription node. Cache-first; D1 and the
// refresh endpoint are only touched on cache miss or near expiry.
export async function resolveSubscriptionCredential(
  env: Record<string, unknown>,
  node: RuntimeNode,
): Promise<ResolveResult> {
  if (!node.auth || node.auth !== 'oauth') {
    return { ok: false, reason: 'unconfigured_provider' };
  }
  const now = Date.now();
  const recentFailure = resolutionFailures.get(node.id);
  if (recentFailure) {
    if (recentFailure.until > now) {
      return { ok: false, reason: recentFailure.reason };
    }
    resolutionFailures.delete(node.id);
  }
  const cached = isolateCache.get(node.id);
  if (cached && cached.expiresAt > now + REFRESH_MARGIN_MS) {
    return { ok: true, token: cached.token };
  }

  const providerConfig = getOAuthProvider(env, node.provider);
  if (!providerConfig) return { ok: false, reason: 'unconfigured_provider' };

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
    await persistAndCache(env, node.id, stored.accessToken, stored.expiresAt);
    return { ok: true, token: stored.accessToken };
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
  const persisted = await storeSubscriptionToken(env, {
    nodeId: node.id,
    provider: node.provider,
    accessToken: refreshed.token,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
    expiresAt,
  });
  if (!persisted) return { ok: false, reason: 'store_unavailable' };
  await persistAndCache(env, node.id, refreshed.token, expiresAt);
  return { ok: true, token: refreshed.token };
}

export function __resetSubscriptionCacheForTests(): void {
  isolateCache.clear();
  resolutionFailures.clear();
}
