-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Labs
--
-- Tier 2 subscription OAuth credential storage. These tables live in the same
-- D1 instance as the token-usage observability tables but are owned by the
-- src/oauth module; the observability store never reads or writes them.
--
-- Access/refresh tokens are stored AES-GCM encrypted with the
-- AIG_TOKEN_ENCRYPTION_KEY Worker secret. D1 at-rest encryption is defense in
-- depth, not the only layer: an account-level D1 read without the Worker
-- secret must not reveal usable upstream tokens.
--
-- Forward-compatibility: additive only. The previous Worker ignores both
-- tables, so a Worker rollback over an applied migration stays safe.

CREATE TABLE IF NOT EXISTS subscription_tokens (
  node_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  token_iv TEXT NOT NULL,
  refresh_iv TEXT,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_flow_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  node_id TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_flow_states_created
  ON oauth_flow_states (created_at);
