-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Labs

ALTER TABLE subscription_tokens ADD COLUMN account_id TEXT;
ALTER TABLE subscription_tokens ADD COLUMN refresh_version INTEGER NOT NULL DEFAULT 0;
