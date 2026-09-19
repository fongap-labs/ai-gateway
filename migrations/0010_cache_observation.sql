-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Studio
--
-- Add protocol-neutral cache observation fields for physical upstream usage.
--
-- upstream_effective_input_tokens stores total upstream input activity after
-- protocol semantics are normalized:
--   * Anthropic cache-read/create tokens are additive to input_tokens.
--   * OpenAI-compatible cached_tokens are already a subset of prompt/input.
--
-- The observed-cache fields are intentionally NOT backfilled. Historical
-- aggregate rows do not preserve whether a zero cache count was explicitly
-- reported or merely absent, so reconstructing a cache-hit ratio would invent
-- evidence. They start at zero and describe post-migration observations only.
--
-- Historical effective input IS reconstructable because, before this migration,
-- the gateway only recognized additive Anthropic cache fields.

-- token_usage_hourly
ALTER TABLE token_usage_hourly ADD COLUMN upstream_effective_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_cache_observed_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_cache_observed_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_cache_read_reports INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_hourly SET
  upstream_effective_input_tokens =
    upstream_input_tokens + upstream_cache_creation_input_tokens + upstream_cache_read_input_tokens;

-- token_usage_model_hourly
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_effective_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_cache_observed_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_cache_observed_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_cache_read_reports INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_model_hourly SET
  upstream_effective_input_tokens =
    upstream_input_tokens + upstream_cache_creation_input_tokens + upstream_cache_read_input_tokens;

-- token_usage_totals
ALTER TABLE token_usage_totals ADD COLUMN upstream_effective_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_cache_observed_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_cache_observed_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_cache_read_reports INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_totals SET
  upstream_effective_input_tokens =
    upstream_input_tokens + upstream_cache_creation_input_tokens + upstream_cache_read_input_tokens;

-- token_usage_daily
ALTER TABLE token_usage_daily ADD COLUMN upstream_effective_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_cache_observed_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_cache_observed_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_cache_read_reports INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_daily SET
  upstream_effective_input_tokens =
    upstream_input_tokens + upstream_cache_creation_input_tokens + upstream_cache_read_input_tokens;

-- token_usage_weekly
ALTER TABLE token_usage_weekly ADD COLUMN upstream_effective_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_cache_observed_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_cache_observed_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_cache_read_reports INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_weekly SET
  upstream_effective_input_tokens =
    upstream_input_tokens + upstream_cache_creation_input_tokens + upstream_cache_read_input_tokens;
