ALTER TABLE token_usage_hourly ADD COLUMN upstream_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_usage_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_usage_missing INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_hourly SET
  upstream_input_tokens = input_tokens,
  upstream_output_tokens = output_tokens,
  upstream_cache_creation_input_tokens = cache_creation_input_tokens,
  upstream_cache_read_input_tokens = cache_read_input_tokens,
  upstream_total_tokens = total_tokens,
  upstream_attempts = requests,
  upstream_usage_reports = usage_reports,
  upstream_usage_missing = usage_missing;

ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_usage_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_usage_missing INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_model_hourly SET
  upstream_input_tokens = input_tokens,
  upstream_output_tokens = output_tokens,
  upstream_cache_creation_input_tokens = cache_creation_input_tokens,
  upstream_cache_read_input_tokens = cache_read_input_tokens,
  upstream_total_tokens = total_tokens,
  upstream_attempts = requests,
  upstream_usage_reports = usage_reports,
  upstream_usage_missing = usage_missing;

ALTER TABLE token_usage_totals ADD COLUMN upstream_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_usage_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_usage_missing INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_totals SET
  upstream_input_tokens = input_tokens,
  upstream_output_tokens = output_tokens,
  upstream_cache_creation_input_tokens = cache_creation_input_tokens,
  upstream_cache_read_input_tokens = cache_read_input_tokens,
  upstream_total_tokens = total_tokens,
  upstream_attempts = requests,
  upstream_usage_reports = usage_reports,
  upstream_usage_missing = usage_missing;

ALTER TABLE token_usage_daily ADD COLUMN upstream_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_usage_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_usage_missing INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_daily SET
  upstream_input_tokens = input_tokens,
  upstream_output_tokens = output_tokens,
  upstream_cache_creation_input_tokens = cache_creation_input_tokens,
  upstream_cache_read_input_tokens = cache_read_input_tokens,
  upstream_total_tokens = total_tokens,
  upstream_attempts = requests,
  upstream_usage_reports = usage_reports,
  upstream_usage_missing = usage_missing;

ALTER TABLE token_usage_weekly ADD COLUMN upstream_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_usage_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_usage_missing INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_weekly SET
  upstream_input_tokens = input_tokens,
  upstream_output_tokens = output_tokens,
  upstream_cache_creation_input_tokens = cache_creation_input_tokens,
  upstream_cache_read_input_tokens = cache_read_input_tokens,
  upstream_total_tokens = total_tokens,
  upstream_attempts = requests,
  upstream_usage_reports = usage_reports,
  upstream_usage_missing = usage_missing;