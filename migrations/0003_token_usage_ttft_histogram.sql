ALTER TABLE token_usage_model_hourly
    ADD COLUMN successful_ttft_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b0 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b1 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b2 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b3 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b4 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b5 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b6 INTEGER NOT NULL DEFAULT 0;
