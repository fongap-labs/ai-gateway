-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Labs
--
-- Subscription token store: account identity + refresh compare-and-swap.
--
-- account_id: provider account identity (e.g., the OpenAI ChatGPT account
-- id) required by some subscription upstreams as a request header. Not a
-- secret; stored in plaintext next to the provider name.
--
-- refresh_version: monotonically increasing counter for refresh-token
-- rotation compare-and-swap. A refresh persists only when the stored
-- version still matches the version the refresher loaded; a losing writer
-- reloads the winner's state instead of clobbering it. Prevents dual
-- authoritative refresh tokens across isolates.
--
-- Forward-compatibility: additive only. The previous Worker ignores both
-- columns, so a Worker rollback over an applied migration stays safe.

ALTER TABLE subscription_tokens ADD COLUMN account_id TEXT;
ALTER TABLE subscription_tokens ADD COLUMN refresh_version INTEGER NOT NULL DEFAULT 0;
