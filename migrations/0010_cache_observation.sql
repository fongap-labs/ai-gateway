ALTER TABLE token_usage_hourly ADD COLUMN upstream_effective_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_cache_observed_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_cache_observed_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_cache_read_reports INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_hourly SET
  upstream_effective_input_tokens =
    upstream_input_tokens + upstream_cache_creation_input_tokens + upstream_cache_read_input_tokens;

ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_effective_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_cache_observed_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_cache_observed_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_cache_read_reports INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_model_hourly SET
  upstream_effective_input_tokens =
    upstream_input_tokens + upstream_cache_creation_input_tokens + upstream_cache_read_input_tokens;

ALTER TABLE token_usage_totals ADD COLUMN upstream_effective_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_cache_observed_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_cache_observed_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_cache_read_reports INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_totals SET
  upstream_effective_input_tokens =
    upstream_input_tokens + upstream_cache_creation_input_tokens + upstream_cache_read_input_tokens;

ALTER TABLE token_usage_daily ADD COLUMN upstream_effective_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_cache_observed_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_cache_observed_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_cache_read_reports INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_daily SET
  upstream_effective_input_tokens =
    upstream_input_tokens + upstream_cache_creation_input_tokens + upstream_cache_read_input_tokens;

ALTER TABLE token_usage_weekly ADD COLUMN upstream_effective_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_cache_observed_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_cache_observed_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_cache_read_reports INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_weekly SET
  upstream_effective_input_tokens =
    upstream_input_tokens + upstream_cache_creation_input_tokens + upstream_cache_read_input_tokens;
