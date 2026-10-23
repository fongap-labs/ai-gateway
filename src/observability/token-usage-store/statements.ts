// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// SQL upserts for the token-usage tables. Every statement is additive: it adds
// the given increments to the stored row. That is why the write buffer can merge
// several events into one increment per (kind, hour, model) without changing the
// stored totals.
//
// Delivered statements touch the delivered columns (requests, usage_reports,
// usage_missing, TTFT buckets) and the upstream_* columns. Upstream statements
// touch only upstream_* columns, so a non-delivered physical attempt never
// fabricates success evidence.

import { TABLE, TABLE_MODEL, TABLE_TOTALS, type tokenStatsD1 } from './keys.ts';

export type UsagePayload = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  effectiveInput: number;
  observedCacheRead: number;
  observedCacheInput: number;
  cacheReadReports: number;
  total: number;
  requests: number;
  reports: number;
  missing: number;
};

export type UsageKind = 'delivered' | 'upstream';

export type UsageDatabase = NonNullable<ReturnType<typeof tokenStatsD1>>;
export type UsageStatement = ReturnType<UsageDatabase['prepare']>;

// Hour-level totals for one kind: the `hour` row of token_usage_hourly and the
// global row of token_usage_totals.
export function buildGlobalStatements(d1: UsageDatabase, kind: UsageKind, hour: string, p: UsagePayload, updatedAt: number): UsageStatement[] {
  return kind === 'delivered' ? deliveredGlobalStatements(d1, hour, p, updatedAt) : upstreamGlobalStatements(d1, hour, p, updatedAt);
}

// Per-model row of token_usage_model_hourly for one kind.
export function buildModelStatement(
  d1: UsageDatabase,
  kind: UsageKind,
  hour: string,
  model: string,
  p: UsagePayload,
  successTtftCount: number,
  ttftBuckets: readonly number[],
): UsageStatement {
  return kind === 'delivered'
    ? deliveredModelStatement(d1, hour, model, p, successTtftCount, ttftBuckets)
    : upstreamModelStatement(d1, hour, model, p);
}

function deliveredGlobalStatements(d1: UsageDatabase, hour: string, p: UsagePayload, updatedAt: number): UsageStatement[] {
  const globalStmt = d1.prepare(
    `INSERT INTO ${TABLE} (
        hour,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing,
        upstream_effective_input_tokens, upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens, upstream_cache_read_reports
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour) DO UPDATE SET
        input_tokens = ${TABLE}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE}.output_tokens + excluded.output_tokens,
        cache_creation_input_tokens = ${TABLE}.cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        cache_read_input_tokens = ${TABLE}.cache_read_input_tokens + excluded.cache_read_input_tokens,
        total_tokens = ${TABLE}.total_tokens + excluded.total_tokens,
        requests = ${TABLE}.requests + excluded.requests,
        usage_reports = ${TABLE}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE}.usage_missing + excluded.usage_missing,
        upstream_input_tokens = ${TABLE}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE}.upstream_usage_missing + excluded.upstream_usage_missing,
        upstream_effective_input_tokens = ${TABLE}.upstream_effective_input_tokens + excluded.upstream_effective_input_tokens,
        upstream_cache_observed_read_tokens = ${TABLE}.upstream_cache_observed_read_tokens + excluded.upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens = ${TABLE}.upstream_cache_observed_input_tokens + excluded.upstream_cache_observed_input_tokens,
        upstream_cache_read_reports = ${TABLE}.upstream_cache_read_reports + excluded.upstream_cache_read_reports`,
  );
  const globalBound = globalStmt.bind(
    hour,
    p.input,
    p.output,
    p.cacheCreation,
    p.cacheRead,
    p.total,
    p.requests,
    p.reports,
    p.missing,
    p.input,
    p.output,
    p.cacheCreation,
    p.cacheRead,
    p.total,
    p.requests,
    p.reports,
    p.missing,
    p.effectiveInput,
    p.observedCacheRead,
    p.observedCacheInput,
    p.cacheReadReports,
  );
  return [globalBound, deliveredTotalsStatement(d1, p, updatedAt)];
}

function deliveredTotalsStatement(d1: UsageDatabase, p: UsagePayload, updatedAt: number): UsageStatement {
  return d1
    .prepare(
      `INSERT INTO ${TABLE_TOTALS} (
        scope,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing, updated_at,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing,
        upstream_effective_input_tokens, upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens, upstream_cache_read_reports
      )
      VALUES ('global', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        input_tokens = ${TABLE_TOTALS}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE_TOTALS}.output_tokens + excluded.output_tokens,
        cache_creation_input_tokens = ${TABLE_TOTALS}.cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        cache_read_input_tokens = ${TABLE_TOTALS}.cache_read_input_tokens + excluded.cache_read_input_tokens,
        total_tokens = ${TABLE_TOTALS}.total_tokens + excluded.total_tokens,
        requests = ${TABLE_TOTALS}.requests + excluded.requests,
        usage_reports = ${TABLE_TOTALS}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE_TOTALS}.usage_missing + excluded.usage_missing,
        updated_at = excluded.updated_at,
        upstream_input_tokens = ${TABLE_TOTALS}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE_TOTALS}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE_TOTALS}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE_TOTALS}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE_TOTALS}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE_TOTALS}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE_TOTALS}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE_TOTALS}.upstream_usage_missing + excluded.upstream_usage_missing,
        upstream_effective_input_tokens = ${TABLE_TOTALS}.upstream_effective_input_tokens + excluded.upstream_effective_input_tokens,
        upstream_cache_observed_read_tokens = ${TABLE_TOTALS}.upstream_cache_observed_read_tokens + excluded.upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens = ${TABLE_TOTALS}.upstream_cache_observed_input_tokens + excluded.upstream_cache_observed_input_tokens,
        upstream_cache_read_reports = ${TABLE_TOTALS}.upstream_cache_read_reports + excluded.upstream_cache_read_reports`,
    )
    .bind(
      p.input,
      p.output,
      p.cacheCreation,
      p.cacheRead,
      p.total,
      p.requests,
      p.reports,
      p.missing,
      new Date(updatedAt).toISOString(),
      p.input,
      p.output,
      p.cacheCreation,
      p.cacheRead,
      p.total,
      p.requests,
      p.reports,
      p.missing,
      p.effectiveInput,
      p.observedCacheRead,
      p.observedCacheInput,
      p.cacheReadReports,
    );
}

function deliveredModelStatement(
  d1: UsageDatabase,
  hour: string,
  model: string,
  p: UsagePayload,
  successTtftCount: number,
  buckets: readonly number[],
): UsageStatement {
  return d1
    .prepare(
      `INSERT INTO ${TABLE_MODEL} (
        hour, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        successful_ttft_count,
        ttft_b0, ttft_b1, ttft_b2, ttft_b3, ttft_b4, ttft_b5, ttft_b6,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing,
        upstream_effective_input_tokens, upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens, upstream_cache_read_reports
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, model) DO UPDATE SET
        input_tokens = ${TABLE_MODEL}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE_MODEL}.output_tokens + excluded.output_tokens,
        cache_creation_input_tokens = ${TABLE_MODEL}.cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        cache_read_input_tokens = ${TABLE_MODEL}.cache_read_input_tokens + excluded.cache_read_input_tokens,
        total_tokens = ${TABLE_MODEL}.total_tokens + excluded.total_tokens,
        requests = ${TABLE_MODEL}.requests + excluded.requests,
        usage_reports = ${TABLE_MODEL}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE_MODEL}.usage_missing + excluded.usage_missing,
        successful_ttft_count = ${TABLE_MODEL}.successful_ttft_count + excluded.successful_ttft_count,
        ttft_b0 = ${TABLE_MODEL}.ttft_b0 + excluded.ttft_b0,
        ttft_b1 = ${TABLE_MODEL}.ttft_b1 + excluded.ttft_b1,
        ttft_b2 = ${TABLE_MODEL}.ttft_b2 + excluded.ttft_b2,
        ttft_b3 = ${TABLE_MODEL}.ttft_b3 + excluded.ttft_b3,
        ttft_b4 = ${TABLE_MODEL}.ttft_b4 + excluded.ttft_b4,
        ttft_b5 = ${TABLE_MODEL}.ttft_b5 + excluded.ttft_b5,
        ttft_b6 = ${TABLE_MODEL}.ttft_b6 + excluded.ttft_b6,
        upstream_input_tokens = ${TABLE_MODEL}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE_MODEL}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE_MODEL}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE_MODEL}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE_MODEL}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE_MODEL}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE_MODEL}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE_MODEL}.upstream_usage_missing + excluded.upstream_usage_missing,
        upstream_effective_input_tokens = ${TABLE_MODEL}.upstream_effective_input_tokens + excluded.upstream_effective_input_tokens,
        upstream_cache_observed_read_tokens = ${TABLE_MODEL}.upstream_cache_observed_read_tokens + excluded.upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens = ${TABLE_MODEL}.upstream_cache_observed_input_tokens + excluded.upstream_cache_observed_input_tokens,
        upstream_cache_read_reports = ${TABLE_MODEL}.upstream_cache_read_reports + excluded.upstream_cache_read_reports`,
    )
    .bind(
      hour,
      model,
      p.input,
      p.output,
      p.cacheCreation,
      p.cacheRead,
      p.total,
      p.requests,
      p.reports,
      p.missing,
      successTtftCount,
      buckets[0],
      buckets[1],
      buckets[2],
      buckets[3],
      buckets[4],
      buckets[5],
      buckets[6],
      p.input,
      p.output,
      p.cacheCreation,
      p.cacheRead,
      p.total,
      p.requests,
      p.reports,
      p.missing,
      p.effectiveInput,
      p.observedCacheRead,
      p.observedCacheInput,
      p.cacheReadReports,
    );
}

function upstreamGlobalStatements(d1: UsageDatabase, hour: string, p: UsagePayload, updatedAt: number): UsageStatement[] {
  const globalBound = d1
    .prepare(
      `INSERT INTO ${TABLE} (
        hour,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing,
        upstream_effective_input_tokens, upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens, upstream_cache_read_reports
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour) DO UPDATE SET
        upstream_input_tokens = ${TABLE}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE}.upstream_usage_missing + excluded.upstream_usage_missing,
        upstream_effective_input_tokens = ${TABLE}.upstream_effective_input_tokens + excluded.upstream_effective_input_tokens,
        upstream_cache_observed_read_tokens = ${TABLE}.upstream_cache_observed_read_tokens + excluded.upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens = ${TABLE}.upstream_cache_observed_input_tokens + excluded.upstream_cache_observed_input_tokens,
        upstream_cache_read_reports = ${TABLE}.upstream_cache_read_reports + excluded.upstream_cache_read_reports`,
    )
    .bind(
      hour,
      p.input,
      p.output,
      p.cacheCreation,
      p.cacheRead,
      p.total,
      p.requests,
      p.reports,
      p.missing,
      p.effectiveInput,
      p.observedCacheRead,
      p.observedCacheInput,
      p.cacheReadReports,
    );
  return [globalBound, upstreamTotalsStatement(d1, p, updatedAt)];
}

function upstreamTotalsStatement(d1: UsageDatabase, p: UsagePayload, updatedAt: number): UsageStatement {
  return d1
    .prepare(
      `INSERT INTO ${TABLE_TOTALS} (
        scope,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing,
        upstream_effective_input_tokens, upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens, upstream_cache_read_reports,
        updated_at
      ) VALUES ('global', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        upstream_input_tokens = ${TABLE_TOTALS}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE_TOTALS}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE_TOTALS}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE_TOTALS}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE_TOTALS}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE_TOTALS}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE_TOTALS}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE_TOTALS}.upstream_usage_missing + excluded.upstream_usage_missing,
        upstream_effective_input_tokens = ${TABLE_TOTALS}.upstream_effective_input_tokens + excluded.upstream_effective_input_tokens,
        upstream_cache_observed_read_tokens = ${TABLE_TOTALS}.upstream_cache_observed_read_tokens + excluded.upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens = ${TABLE_TOTALS}.upstream_cache_observed_input_tokens + excluded.upstream_cache_observed_input_tokens,
        upstream_cache_read_reports = ${TABLE_TOTALS}.upstream_cache_read_reports + excluded.upstream_cache_read_reports,
        updated_at = excluded.updated_at`,
    )
    .bind(
      p.input,
      p.output,
      p.cacheCreation,
      p.cacheRead,
      p.total,
      p.requests,
      p.reports,
      p.missing,
      p.effectiveInput,
      p.observedCacheRead,
      p.observedCacheInput,
      p.cacheReadReports,
      new Date(updatedAt).toISOString(),
    );
}

function upstreamModelStatement(d1: UsageDatabase, hour: string, model: string, p: UsagePayload): UsageStatement {
  return d1
    .prepare(
      `INSERT INTO ${TABLE_MODEL} (
        hour, model,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing,
        upstream_effective_input_tokens, upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens, upstream_cache_read_reports
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, model) DO UPDATE SET
        upstream_input_tokens = ${TABLE_MODEL}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE_MODEL}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE_MODEL}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE_MODEL}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE_MODEL}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE_MODEL}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE_MODEL}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE_MODEL}.upstream_usage_missing + excluded.upstream_usage_missing,
        upstream_effective_input_tokens = ${TABLE_MODEL}.upstream_effective_input_tokens + excluded.upstream_effective_input_tokens,
        upstream_cache_observed_read_tokens = ${TABLE_MODEL}.upstream_cache_observed_read_tokens + excluded.upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens = ${TABLE_MODEL}.upstream_cache_observed_input_tokens + excluded.upstream_cache_observed_input_tokens,
        upstream_cache_read_reports = ${TABLE_MODEL}.upstream_cache_read_reports + excluded.upstream_cache_read_reports`,
    )
    .bind(
      hour,
      model,
      p.input,
      p.output,
      p.cacheCreation,
      p.cacheRead,
      p.total,
      p.requests,
      p.reports,
      p.missing,
      p.effectiveInput,
      p.observedCacheRead,
      p.observedCacheInput,
      p.cacheReadReports,
    );
}
