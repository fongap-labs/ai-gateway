ALTER TABLE token_usage_hourly ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_totals ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_daily ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_weekly ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;