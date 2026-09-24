// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Tier 2 subscription token store.
//
// Storage model:
//   - D1 (TOKEN_STATS_DB binding, same instance as observability tables but
//     owned exclusively by src/oauth) is the source of truth for OAuth
//     access/refresh tokens. Tokens are AES-GCM encrypted at write time.
//   - Isolate-local memory caches the decrypted access token with its expiry.
//     The scheduling path never touches D1: only this resolver does, on cache
//     miss (cold isolate or token near expiry).
//
// Fail-closed invariants:
//   - No encryption key configured -> store refuses to persist and resolve.
//   - Missing/expired token with no usable refresh token -> resolve fails and
//     the dispatch layer rotates to another node (never sends a stale token).

import { encryptSecret, decryptSecret, hasTokenKey } from './crypto.ts';

export type StoredSubscriptionToken = {
  nodeId: string,
  provider: string,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: number,
  status: string,
};

export type SubscriptionTokenRow = {
  node_id: string,
  provider: string,
  access_token_enc: string,
  refresh_token_enc: string | null,
  token_iv: string,
  refresh_iv: string | null,
  expires_at: number,
  status: string,
};

export type OAuthFlowStateRow = {
  state: string,
  provider: string,
  node_id: string,
  code_verifier: string,
  created_at: number,
};

export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

type D1Like = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => {
      first: () => Promise<unknown>,
      all: () => Promise<{ results: unknown[] }>,
      run: () => Promise<unknown>,
    },
  },
};

function d1(env: Record<string, unknown>): D1Like | null {
  const db = (env as Record<string, unknown>).TOKEN_STATS_DB as D1Like | undefined;
  if (!db || typeof db.prepare !== 'function') return null;
  return db;
}

// ---- Flow states (short-lived PKCE session state) --------------------------

export async function saveFlowState(
  env: Record<string, unknown>,
  row: OAuthFlowStateRow,
): Promise<boolean> {
  const db = d1(env);
  if (!db) return false;
  try {
    await db.prepare(
      'INSERT INTO oauth_flow_states (state, provider, node_id, code_verifier, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(row.state, row.provider, row.node_id, row.code_verifier, row.created_at).run();
    return true;
  } catch {
    return false;
  }
}

export async function loadFlowState(
  env: Record<string, unknown>,
  state: string,
): Promise<OAuthFlowStateRow | null> {
  const db = d1(env);
  if (!db) return null;
  try {
    const row = await db.prepare(
      'SELECT state, provider, node_id, code_verifier, created_at FROM oauth_flow_states WHERE state = ?',
    ).bind(state).first();
    if (!row || typeof row !== 'object') return null;
    const record = row as Record<string, unknown>;
    if (typeof record.provider !== 'string' || typeof record.node_id !== 'string'
      || typeof record.code_verifier !== 'string' || typeof record.created_at !== 'number') {
      return null;
    }
    return {
      state,
      provider: record.provider,
      node_id: record.node_id,
      code_verifier: record.code_verifier,
      created_at: record.created_at,
    };
  } catch {
    return null;
  }
}

export async function deleteFlowState(
  env: Record<string, unknown>,
  state: string,
): Promise<void> {
  const db = d1(env);
  if (!db) return;
  try {
    await db.prepare('DELETE FROM oauth_flow_states WHERE state = ?').bind(state).run();
  } catch {
    // Expired states are also purged opportunistically; deletion failure is non-fatal.
  }
}

export async function purgeExpiredFlowStates(env: Record<string, unknown>): Promise<void> {
  const db = d1(env);
  if (!db) return;
  try {
    const cutoff = Date.now() - OAUTH_FLOW_TTL_MS;
    await db.prepare('DELETE FROM oauth_flow_states WHERE created_at < ?').bind(cutoff).run();
  } catch {
    // Non-fatal; the per-state TTL check enforces correctness on read.
  }
}

// ---- Subscription tokens ----------------------------------------------------

export async function storeSubscriptionToken(
  env: Record<string, unknown>,
  input: {
    nodeId: string,
    provider: string,
    accessToken: string,
    refreshToken: string | null,
    expiresAt: number,
  },
): Promise<boolean> {
  const db = d1(env);
  if (!db) return false;
  if (!hasTokenKey(env)) return false;
  const accessEnc = await encryptSecret(env, input.accessToken);
  if (!accessEnc) return false;
  const refreshEnc = input.refreshToken ? await encryptSecret(env, input.refreshToken) : null;
  const now = Date.now();
  try {
    await db.prepare(
      `INSERT INTO subscription_tokens
         (node_id, provider, access_token_enc, refresh_token_enc, token_iv, refresh_iv, expires_at, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
       ON CONFLICT(node_id) DO UPDATE SET
         provider = excluded.provider,
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = COALESCE(excluded.refresh_token_enc, subscription_tokens.refresh_token_enc),
         refresh_iv = COALESCE(excluded.refresh_iv, subscription_tokens.refresh_iv),
         expires_at = excluded.expires_at,
         status = 'active',
         updated_at = excluded.updated_at`,
    ).bind(
      input.nodeId, input.provider,
      accessEnc.ciphertextB64, refreshEnc?.ciphertextB64 ?? null,
      accessEnc.ivB64, refreshEnc?.ivB64 ?? null,
      input.expiresAt, now,
    ).run();
    return true;
  } catch {
    return false;
  }
}

export async function loadSubscriptionToken(
  env: Record<string, unknown>,
  nodeId: string,
): Promise<StoredSubscriptionToken | null> {
  const db = d1(env);
  if (!db) return null;
  if (!hasTokenKey(env)) return null;
  try {
    const row = await db.prepare(
      'SELECT node_id, provider, access_token_enc, refresh_token_enc, token_iv, refresh_iv, expires_at, status FROM subscription_tokens WHERE node_id = ?',
    ).bind(nodeId).first();
    if (!row || typeof row !== 'object') return null;
    const record = row as Record<string, unknown>;
    if (typeof record.provider !== 'string'
      || typeof record.access_token_enc !== 'string' || typeof record.token_iv !== 'string'
      || typeof record.expires_at !== 'number') {
      return null;
    }
    const accessToken = await decryptSecret(env, {
      ciphertextB64: record.access_token_enc,
      ivB64: record.token_iv,
    });
    if (!accessToken) return null;
    let refreshToken: string | null = null;
    if (typeof record.refresh_token_enc === 'string' && typeof record.refresh_iv === 'string') {
      refreshToken = await decryptSecret(env, {
        ciphertextB64: record.refresh_token_enc,
        ivB64: record.refresh_iv,
      });
    }
    return {
      nodeId,
      provider: record.provider,
      accessToken,
      refreshToken,
      expiresAt: record.expires_at,
      status: typeof record.status === 'string' ? record.status : 'active',
    };
  } catch {
    return null;
  }
}

export async function markTokenStatus(
  env: Record<string, unknown>,
  nodeId: string,
  status: string,
): Promise<void> {
  const db = d1(env);
  if (!db) return;
  try {
    await db.prepare(
      'UPDATE subscription_tokens SET status = ?, updated_at = ? WHERE node_id = ?',
    ).bind(status, Date.now(), nodeId).run();
  } catch {
    // Non-fatal: dispatch cooldown already isolates the node.
  }
}
