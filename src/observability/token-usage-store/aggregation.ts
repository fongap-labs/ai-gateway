// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Token Usage Aggregation.
//
// Both accounting views travel through the same hourly -> daily -> weekly
// materialization pipeline:
//   legacy columns   = successfully delivered responses
//   upstream_*       = physical upstream attempts
// This keeps retention/query behavior aligned without duplicating tables.

import { getUtcWeekStartUtcMs } from '../time-buckets.ts';
import {
  TABLE, TABLE_DAILY, TABLE_WEEKLY,
  isoDayUtc8, tokenStatsD1,
} from './keys.ts';
import type { D1PreparedStatement } from '../../types/cloudflare.ts';
import type { GatewayEnv } from '../../types/runtime.ts';

type AggregateRow = {
  input: number, output: number, cacheCreation: number, cacheRead: number, total: number,
  requests: number, reports: number, missing: number,
  upstreamInput: number, upstreamOutput: number, upstreamCacheCreation: number, upstreamCacheRead: number,
  upstreamEffectiveInput: number, upstreamObservedRead: number,
  upstreamObservedInput: number, upstreamReadReports: number,
  upstreamTotal: number, upstreamAttempts: number, upstreamReports: number, upstreamMissing: number,
};


type AggregateSourceRow = {
  hour?: string,
  day?: string,
  input_tokens?: number | null,
  output_tokens?: number | null,
  cache_creation_input_tokens?: number | null,
  cache_read_input_tokens?: number | null,
  total_tokens?: number | null,
  requests?: number | null,
  usage_reports?: number | null,
  usage_missing?: number | null,
  upstream_input_tokens?: number | null,
  upstream_output_tokens?: number | null,
  upstream_cache_creation_input_tokens?: number | null,
  upstream_cache_read_input_tokens?: number | null,
  upstream_effective_input_tokens?: number | null,
  upstream_cache_observed_read_tokens?: number | null,
  upstream_cache_observed_input_tokens?: number | null,
  upstream_cache_read_reports?: number | null,
  upstream_total_tokens?: number | null,
  upstream_attempts?: number | null,
  upstream_usage_reports?: number | null,
  upstream_usage_missing?: number | null,
};

function emptyAggregate(): AggregateRow {
  return {
    input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0,
    requests: 0, reports: 0, missing: 0,
    upstreamInput: 0, upstreamOutput: 0, upstreamCacheCreation: 0, upstreamCacheRead: 0,
    upstreamEffectiveInput: 0, upstreamObservedRead: 0,
    upstreamObservedInput: 0, upstreamReadReports: 0,
    upstreamTotal: 0, upstreamAttempts: 0, upstreamReports: 0, upstreamMissing: 0,
  };
}

function addRow(current: AggregateRow, row: AggregateSourceRow): AggregateRow {
  return {
    input: current.input + (Number(row.input_tokens) || 0),
    output: current.output + (Number(row.output_tokens) || 0),
    cacheCreation: current.cacheCreation + (Number(row.cache_creation_input_tokens) || 0),
    cacheRead: current.cacheRead + (Number(row.cache_read_input_tokens) || 0),
    total: current.total + (Number(row.total_tokens) || 0),
    requests: current.requests + (Number(row.requests) || 0),
    reports: current.reports + (Number(row.usage_reports) || 0),
    missing: current.missing + (Number(row.usage_missing) || 0),
    upstreamInput: current.upstreamInput + (Number(row.upstream_input_tokens) || 0),
    upstreamOutput: current.upstreamOutput + (Number(row.upstream_output_tokens) || 0),
    upstreamCacheCreation: current.upstreamCacheCreation + (Number(row.upstream_cache_creation_input_tokens) || 0),
    upstreamCacheRead: current.upstreamCacheRead + (Number(row.upstream_cache_read_input_tokens) || 0),
    upstreamEffectiveInput: current.upstreamEffectiveInput + (Number(row.upstream_effective_input_tokens) || 0),
    upstreamObservedRead: current.upstreamObservedRead + (Number(row.upstream_cache_observed_read_tokens) || 0),
    upstreamObservedInput: current.upstreamObservedInput + (Number(row.upstream_cache_observed_input_tokens) || 0),
    upstreamReadReports: current.upstreamReadReports + (Number(row.upstream_cache_read_reports) || 0),
    upstreamTotal: current.upstreamTotal + (Number(row.upstream_total_tokens) || 0),
    upstreamAttempts: current.upstreamAttempts + (Number(row.upstream_attempts) || 0),
    upstreamReports: current.upstreamReports + (Number(row.upstream_usage_reports) || 0),
    upstreamMissing: current.upstreamMissing + (Number(row.upstream_usage_missing) || 0),
  };
}

export async function aggregateHourlyToDaily(env: GatewayEnv, now: number = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  try {
    const result = await d1.prepare(
      `SELECT hour,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing,
        upstream_effective_input_tokens, upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens, upstream_cache_read_reports
       FROM ${TABLE}`
    ).all<AggregateSourceRow>();
    const rows = Array.isArray(result?.results) ? result.results : [];

    const byDay = new Map<string, AggregateRow>();
    for (const row of rows) {
      if (!row || typeof row.hour !== 'string') continue;
      const timestamp = Date.parse(row.hour);
      if (!Number.isFinite(timestamp)) continue;
      const day = isoDayUtc8(timestamp);
      byDay.set(day, addRow(byDay.get(day) || emptyAggregate(), row));
    }

    const upsertStmt = d1.prepare(
      `INSERT INTO ${TABLE_DAILY} (
        day,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing,
        upstream_effective_input_tokens, upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens, upstream_cache_read_reports
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_creation_input_tokens = excluded.cache_creation_input_tokens,
         cache_read_input_tokens = excluded.cache_read_input_tokens,
         total_tokens = excluded.total_tokens,
         requests = excluded.requests,
         usage_reports = excluded.usage_reports,
         usage_missing = excluded.usage_missing,
         upstream_input_tokens = excluded.upstream_input_tokens,
         upstream_output_tokens = excluded.upstream_output_tokens,
         upstream_cache_creation_input_tokens = excluded.upstream_cache_creation_input_tokens,
         upstream_cache_read_input_tokens = excluded.upstream_cache_read_input_tokens,
         upstream_total_tokens = excluded.upstream_total_tokens,
         upstream_attempts = excluded.upstream_attempts,
         upstream_usage_reports = excluded.upstream_usage_reports,
         upstream_usage_missing = excluded.upstream_usage_missing,
         upstream_effective_input_tokens = excluded.upstream_effective_input_tokens,
         upstream_cache_observed_read_tokens = excluded.upstream_cache_observed_read_tokens,
         upstream_cache_observed_input_tokens = excluded.upstream_cache_observed_input_tokens,
         upstream_cache_read_reports = excluded.upstream_cache_read_reports`
    );
    const batch: D1PreparedStatement[] = [];
    for (const [day, aggregate] of byDay) {
      batch.push(upsertStmt.bind(
        day,
        aggregate.input, aggregate.output, aggregate.cacheCreation, aggregate.cacheRead, aggregate.total, aggregate.requests, aggregate.reports, aggregate.missing,
        aggregate.upstreamInput, aggregate.upstreamOutput, aggregate.upstreamCacheCreation, aggregate.upstreamCacheRead, aggregate.upstreamTotal,
        aggregate.upstreamAttempts, aggregate.upstreamReports, aggregate.upstreamMissing,
        aggregate.upstreamEffectiveInput, aggregate.upstreamObservedRead, aggregate.upstreamObservedInput, aggregate.upstreamReadReports,
      ));
    }
    if (batch.length) await d1.batch(batch);
    return { aggregatedDays: batch.length };
  } catch (error) {
    console.error('aggregateHourlyToDaily failed:', (error as { message?: unknown } | null | undefined)?.message || error);
    throw error;
  }
}

export async function aggregateDailyToWeekly(env: GatewayEnv, now: number = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  try {
    const result = await d1.prepare(
      `SELECT day,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing,
        upstream_effective_input_tokens, upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens, upstream_cache_read_reports
       FROM ${TABLE_DAILY}`
    ).all<AggregateSourceRow>();
    const rows = Array.isArray(result?.results) ? result.results : [];

    const byWeek = new Map<string, AggregateRow>();
    for (const row of rows) {
      if (!row || typeof row.day !== 'string') continue;
      const dayTime = Date.parse(row.day + 'T12:00:00Z');
      if (!Number.isFinite(dayTime)) continue;
      const weekStart = new Date(getUtcWeekStartUtcMs(dayTime)).toISOString().slice(0, 10);
      byWeek.set(weekStart, addRow(byWeek.get(weekStart) || emptyAggregate(), row));
    }

    const upsertStmt = d1.prepare(
      `INSERT INTO ${TABLE_WEEKLY} (
        week_start,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing,
        upstream_effective_input_tokens, upstream_cache_observed_read_tokens,
        upstream_cache_observed_input_tokens, upstream_cache_read_reports
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_creation_input_tokens = excluded.cache_creation_input_tokens,
         cache_read_input_tokens = excluded.cache_read_input_tokens,
         total_tokens = excluded.total_tokens,
         requests = excluded.requests,
         usage_reports = excluded.usage_reports,
         usage_missing = excluded.usage_missing,
         upstream_input_tokens = excluded.upstream_input_tokens,
         upstream_output_tokens = excluded.upstream_output_tokens,
         upstream_cache_creation_input_tokens = excluded.upstream_cache_creation_input_tokens,
         upstream_cache_read_input_tokens = excluded.upstream_cache_read_input_tokens,
         upstream_total_tokens = excluded.upstream_total_tokens,
         upstream_attempts = excluded.upstream_attempts,
         upstream_usage_reports = excluded.upstream_usage_reports,
         upstream_usage_missing = excluded.upstream_usage_missing,
         upstream_effective_input_tokens = excluded.upstream_effective_input_tokens,
         upstream_cache_observed_read_tokens = excluded.upstream_cache_observed_read_tokens,
         upstream_cache_observed_input_tokens = excluded.upstream_cache_observed_input_tokens,
         upstream_cache_read_reports = excluded.upstream_cache_read_reports`
    );
    const batch: D1PreparedStatement[] = [];
    for (const [weekStart, aggregate] of byWeek) {
      batch.push(upsertStmt.bind(
        weekStart,
        aggregate.input, aggregate.output, aggregate.cacheCreation, aggregate.cacheRead, aggregate.total, aggregate.requests, aggregate.reports, aggregate.missing,
        aggregate.upstreamInput, aggregate.upstreamOutput, aggregate.upstreamCacheCreation, aggregate.upstreamCacheRead, aggregate.upstreamTotal,
        aggregate.upstreamAttempts, aggregate.upstreamReports, aggregate.upstreamMissing,
        aggregate.upstreamEffectiveInput, aggregate.upstreamObservedRead, aggregate.upstreamObservedInput, aggregate.upstreamReadReports,
      ));
    }
    if (batch.length) await d1.batch(batch);
    return { aggregatedWeeks: batch.length };
  } catch (error) {
    console.error('aggregateDailyToWeekly failed:', (error as { message?: unknown } | null | undefined)?.message || error);
    throw error;
  }
}
