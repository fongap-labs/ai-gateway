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
