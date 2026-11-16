CREATE TABLE IF NOT EXISTS token_usage_model_hourly (
    hour TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    usage_reports INTEGER NOT NULL DEFAULT 0,
    usage_missing INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, model)
);

CREATE INDEX IF NOT EXISTS idx_token_usage_model_hourly_hour
    ON token_usage_model_hourly (hour);
