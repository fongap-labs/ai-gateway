-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Labs

CREATE TABLE IF NOT EXISTS token_usage_hourly (
    hour TEXT PRIMARY KEY,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    usage_reports INTEGER NOT NULL DEFAULT 0,
    usage_missing INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_token_usage_hourly_hour ON token_usage_hourly (hour);
