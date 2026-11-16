CREATE TABLE IF NOT EXISTS token_usage_totals (
    scope TEXT PRIMARY KEY CHECK (scope = 'global'),
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    usage_reports INTEGER NOT NULL DEFAULT 0,
    usage_missing INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO token_usage_totals (
    scope,
    input_tokens,
    output_tokens,
    total_tokens,
    requests,
    usage_reports,
    usage_missing,
    updated_at
)
SELECT
    'global',
    COALESCE(SUM(input_tokens), 0),
    COALESCE(SUM(output_tokens), 0),
    COALESCE(SUM(total_tokens), 0),
    COALESCE(SUM(requests), 0),
    COALESCE(SUM(usage_reports), 0),
    COALESCE(SUM(usage_missing), 0),
    datetime('now')
FROM token_usage_hourly;