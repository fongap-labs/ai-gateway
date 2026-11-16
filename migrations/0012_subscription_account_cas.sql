ALTER TABLE subscription_tokens ADD COLUMN account_id TEXT;
ALTER TABLE subscription_tokens ADD COLUMN refresh_version INTEGER NOT NULL DEFAULT 0;
