// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Dashboard consumption reads keep Token totals on physical upstream usage.
// The activity-series request count uses delivered responses so retries,
// fallback and hedge attempts do not inflate the public “次请求” metric.

import {
  TABLE, TABLE_MODEL, TABLE_TOTALS, TABLE_DAILY,
  HOUR_MS, DAY_MS,
  normalizeHour, normalizeModelKey, utc8DayStartUtcMs, isoDayUtc8,
  DISPLAY_TIMEZONE_OFFSET_MS,
  tokenStatsD1,
} from './keys.ts';
import type { GatewayEnv } from '../../types/runtime.ts';

export type UpstreamDailyWindowRow = { total: number, requests: number, reports: number, missing: number };


type NumericCell = number | null;

type UpstreamTotalsRow = {
  upstream_effective_input_tokens?: NumericCell,
  upstream_input_tokens?: NumericCell,
  upstream_output_tokens?: NumericCell,
  upstream_cache_creation_input_tokens?: NumericCell,
  upstream_cache_read_input_tokens?: NumericCell,
  upstream_cache_observed_read_tokens?: NumericCell,
  upstream_cache_observed_input_tokens?: NumericCell,
  upstream_cache_read_reports?: NumericCell,
  upstream_total_tokens?: NumericCell,
  upstream_attempts?: NumericCell,
  upstream_usage_reports?: NumericCell,
  upstream_usage_missing?: NumericCell,
};

type UpstreamWindowRow = {
  today_total?: NumericCell,
  today_attempts?: NumericCell,
  h24_total?: NumericCell,
  h24_attempts?: NumericCell,
  h24_input?: NumericCell,
  h24_input_raw?: NumericCell,
  h24_cache_creation?: NumericCell,
  h24_cache_read?: NumericCell,
  h24_cache_observed_read?: NumericCell,
  h24_cache_observed_input?: NumericCell,
  h24_cache_read_reports?: NumericCell,
  h24_output?: NumericCell,
  d7_total?: NumericCell,
  d7_attempts?: NumericCell,
};

type UpstreamFallbackRow = {
  t?: NumericCell,
  a?: NumericCell,
  rp?: NumericCell,
  rm?: NumericCell,
  effective_input?: NumericCell,
  input_raw?: NumericCell,
  cache_creation?: NumericCell,
  output?: NumericCell,
  cache_read?: NumericCell,
  cache_observed_read?: NumericCell,
  cache_observed_input?: NumericCell,
  cache_read_reports?: NumericCell,
};

type UpstreamDailyRow = {
  day: string,
  upstream_total_tokens?: NumericCell,
  requests?: NumericCell,
  upstream_usage_reports?: NumericCell,
  upstream_usage_missing?: NumericCell,
};

type UpstreamHourlyRow = {
  hour: string,
  upstream_total_tokens?: NumericCell,
  requests?: NumericCell,
  upstream_usage_reports?: NumericCell,
  upstream_usage_missing?: NumericCell,
};

type UpstreamModelRow = {
  model?: string | null,
  total?: NumericCell,
  attempts?: NumericCell,
};

const asMessage = (e: unknown): string => String((e as { message?: unknown } | null | undefined)?.message || e);

export async function loadUpstreamSummary(env: GatewayEnv, now: number = Date.now()): Promise<{
  available: true,
  today: { total: number, requests: number },
  h24: { total: number, requests: number, input: number, output: number, cacheRead: number, cacheReadReports: number, cacheHitRatio: number | null },
  d7: { total: number, requests: number },
  cumulative: { total: number, requests: number, reports: number, missing: number, input: number, output: number, cacheRead: number, cacheReadReports: number, cacheHitRatio: number | null },
  coverage: number | null,
} | { available: false, error: string } | null> {
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  const todayStart = normalizeHour(utc8DayStartUtcMs(now));
  const h24Start = normalizeHour(now - 24 * HOUR_MS);
  const d7Start = normalizeHour(now - 7 * DAY_MS);

  const splitInput = (input: number, cacheRead: number): number =>
    Math.max(0, input - cacheRead);
  const getCacheRatio = (reports: number, cacheRead: number, input: number): number | null =>
    reports > 0 && input > 0 ? cacheRead / input : null;

  let totalsRow: UpstreamTotalsRow | null = null;
  let hasTotalsObservation = true;
  try {
    totalsRow = await d1.prepare(
      `SELECT
         upstream_effective_input_tokens,
         upstream_output_tokens,
         upstream_cache_read_input_tokens,
         upstream_cache_observed_read_tokens,
         upstream_cache_observed_input_tokens,
         upstream_cache_read_reports,
         upstream_total_tokens,
         upstream_attempts,
         upstream_usage_reports,
         upstream_usage_missing
       FROM ${TABLE_TOTALS} WHERE scope = 'global'`
    ).first<UpstreamTotalsRow>();
  } catch {
    // Rolling-deploy compatibility with schema <= 0009. Before 0010 every
    // recognized cache-read field was Anthropic-style and additive, so the
    // historical effective-input value can be reconstructed exactly.
    hasTotalsObservation = false;
    try {
      totalsRow = await d1.prepare(
        `SELECT
           upstream_input_tokens,
           upstream_output_tokens,
           upstream_cache_creation_input_tokens,
           upstream_cache_read_input_tokens,
           upstream_total_tokens,
           upstream_attempts,
           upstream_usage_reports,
           upstream_usage_missing
         FROM ${TABLE_TOTALS} WHERE scope = 'global'`
      ).first<UpstreamTotalsRow>();
    } catch { /* hourly fallback below */ }
  }

  let hourlyRow: UpstreamWindowRow | null | undefined;
  let hasHourlyObservation = true;
  try {
    hourlyRow = await d1.prepare(
      `SELECT
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_total_tokens END), 0) AS today_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_attempts END), 0) AS today_attempts,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_total_tokens END), 0) AS h24_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_attempts END), 0) AS h24_attempts,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_effective_input_tokens END), 0) AS h24_input,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_cache_read_input_tokens END), 0) AS h24_cache_read,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_cache_observed_read_tokens END), 0) AS h24_cache_observed_read,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_cache_observed_input_tokens END), 0) AS h24_cache_observed_input,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_cache_read_reports END), 0) AS h24_cache_read_reports,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_output_tokens END), 0) AS h24_output,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_total_tokens END), 0) AS d7_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_attempts END), 0) AS d7_attempts
       FROM ${TABLE}`
    ).bind(
      todayStart, todayStart,
      h24Start, h24Start, h24Start, h24Start, h24Start, h24Start, h24Start, h24Start,
      d7Start, d7Start,
    ).first<UpstreamWindowRow>();
  } catch {
    hasHourlyObservation = false;
    try {
      hourlyRow = await d1.prepare(
        `SELECT
         COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_total_tokens END), 0) AS today_total,
         COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_attempts END), 0) AS today_attempts,
         COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_total_tokens END), 0) AS h24_total,
         COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_attempts END), 0) AS h24_attempts,
         COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_input_tokens END), 0) AS h24_input_raw,
         COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_cache_creation_input_tokens END), 0) AS h24_cache_creation,
         COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_cache_read_input_tokens END), 0) AS h24_cache_read,
         COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_output_tokens END), 0) AS h24_output,
         COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_total_tokens END), 0) AS d7_total,
         COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_attempts END), 0) AS d7_attempts
         FROM ${TABLE}`
      ).bind(todayStart, todayStart, h24Start, h24Start, h24Start, h24Start, h24Start, h24Start, d7Start, d7Start).first<UpstreamWindowRow>();
    } catch (e) {
      return { available: false, error: `loadUpstreamSummary: ${asMessage(e)}` };
    }
  }
  if (!hourlyRow || typeof hourlyRow !== 'object') return null;

  let total = 0, attempts = 0, reports = 0, missing = 0;
  let cumulativeEffectiveInput = 0, cumulativeOutput = 0, cumulativeStoredRead = 0;
  let cumulativeObservedRead = 0, cumulativeObservedInput = 0, cumulativeReadReports = 0;

  if (totalsRow && typeof totalsRow === 'object') {
    total = Number(totalsRow.upstream_total_tokens) || 0;
    attempts = Number(totalsRow.upstream_attempts) || 0;
    reports = Number(totalsRow.upstream_usage_reports) || 0;
    missing = Number(totalsRow.upstream_usage_missing) || 0;
    cumulativeOutput = Number(totalsRow.upstream_output_tokens) || 0;
    cumulativeStoredRead = Number(totalsRow.upstream_cache_read_input_tokens) || 0;
    if (hasTotalsObservation) {
      cumulativeEffectiveInput = Number(totalsRow.upstream_effective_input_tokens) || 0;
      cumulativeObservedRead = Number(totalsRow.upstream_cache_observed_read_tokens) || 0;
      cumulativeObservedInput = Number(totalsRow.upstream_cache_observed_input_tokens) || 0;
      cumulativeReadReports = Number(totalsRow.upstream_cache_read_reports) || 0;
    } else {
      cumulativeEffectiveInput = (Number(totalsRow.upstream_input_tokens) || 0)
        + (Number(totalsRow.upstream_cache_creation_input_tokens) || 0)
        + cumulativeStoredRead;
    }
  } else {
    let fb: UpstreamFallbackRow | null | undefined;
    let fbHasObservation = true;
    try {
      fb = await d1.prepare(
        `SELECT COALESCE(SUM(upstream_total_tokens),0) AS t,
                COALESCE(SUM(upstream_attempts),0) AS a,
                COALESCE(SUM(upstream_usage_reports),0) AS rp,
                COALESCE(SUM(upstream_usage_missing),0) AS rm,
                COALESCE(SUM(upstream_effective_input_tokens),0) AS effective_input,
                COALESCE(SUM(upstream_output_tokens),0) AS output,
                COALESCE(SUM(upstream_cache_read_input_tokens),0) AS cache_read,
                COALESCE(SUM(upstream_cache_observed_read_tokens),0) AS cache_observed_read,
                COALESCE(SUM(upstream_cache_observed_input_tokens),0) AS cache_observed_input,
                COALESCE(SUM(upstream_cache_read_reports),0) AS cache_read_reports
         FROM ${TABLE}`
      ).first<UpstreamFallbackRow>();
    } catch {
      fbHasObservation = false;
      try {
        fb = await d1.prepare(
          `SELECT COALESCE(SUM(upstream_total_tokens),0) AS t,
                  COALESCE(SUM(upstream_attempts),0) AS a,
                  COALESCE(SUM(upstream_usage_reports),0) AS rp,
                  COALESCE(SUM(upstream_usage_missing),0) AS rm,
                  COALESCE(SUM(upstream_input_tokens),0) AS input_raw,
                  COALESCE(SUM(upstream_cache_creation_input_tokens),0) AS cache_creation,
                  COALESCE(SUM(upstream_cache_read_input_tokens),0) AS cache_read,
                  COALESCE(SUM(upstream_output_tokens),0) AS output
           FROM ${TABLE}`
        ).first<UpstreamFallbackRow>();
      } catch { fb = null; }
    }
    total = Number(fb?.t) || 0;
    attempts = Number(fb?.a) || 0;
    reports = Number(fb?.rp) || 0;
    missing = Number(fb?.rm) || 0;
    cumulativeOutput = Number(fb?.output) || 0;
    cumulativeStoredRead = Number(fb?.cache_read) || 0;
    if (fbHasObservation) {
      cumulativeEffectiveInput = Number(fb?.effective_input) || 0;
      cumulativeObservedRead = Number(fb?.cache_observed_read) || 0;
      cumulativeObservedInput = Number(fb?.cache_observed_input) || 0;
      cumulativeReadReports = Number(fb?.cache_read_reports) || 0;
    } else {
      cumulativeEffectiveInput = (Number(fb?.input_raw) || 0)
        + (Number(fb?.cache_creation) || 0)
        + cumulativeStoredRead;
    }
  }

  const h24StoredRead = Number(hourlyRow.h24_cache_read) || 0;
  const h24EffectiveInput = hasHourlyObservation
    ? (Number(hourlyRow.h24_input) || 0)
    : (Number(hourlyRow.h24_input_raw) || 0)
      + (Number(hourlyRow.h24_cache_creation) || 0)
      + h24StoredRead;
  const h24ObservedRead = hasHourlyObservation ? (Number(hourlyRow.h24_cache_observed_read) || 0) : 0;
  const h24ObservedInput = hasHourlyObservation ? (Number(hourlyRow.h24_cache_observed_input) || 0) : 0;
  const h24ReadReports = hasHourlyObservation ? (Number(hourlyRow.h24_cache_read_reports) || 0) : 0;

  const denominator = reports + missing;
  return {
    available: true,
    today: { total: Number(hourlyRow.today_total) || 0, requests: Number(hourlyRow.today_attempts) || 0 },
    h24: {
      total: Number(hourlyRow.h24_total) || 0,
      requests: Number(hourlyRow.h24_attempts) || 0,
      input: splitInput(h24EffectiveInput, h24ObservedRead),
      output: Number(hourlyRow.h24_output) || 0,
      cacheRead: h24ObservedRead,
      cacheReadReports: h24ReadReports,
      cacheHitRatio: getCacheRatio(h24ReadReports, h24ObservedRead, h24ObservedInput),
    },
    d7: { total: Number(hourlyRow.d7_total) || 0, requests: Number(hourlyRow.d7_attempts) || 0 },
    cumulative: {
      total,
      requests: attempts,
      reports,
      missing,
      input: splitInput(cumulativeEffectiveInput, cumulativeObservedRead),
      output: cumulativeOutput,
      cacheRead: cumulativeObservedRead,
      cacheReadReports: cumulativeReadReports,
      cacheHitRatio: getCacheRatio(cumulativeReadReports, cumulativeObservedRead, cumulativeObservedInput),
    },
    coverage: denominator === 0 ? null : reports / denominator,
  };
}

export async function loadUpstreamDaily(env: GatewayEnv, startDayIso: string, now: number = Date.now()): Promise<Map<string, UpstreamDailyWindowRow> | { available: false, error: string } | null> {
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  const map = new Map<string, UpstreamDailyWindowRow>();
  let dailyRows: UpstreamDailyRow[] = [];
  let dailyTableHasData = false;

  try {
    const res = await d1.prepare(
      `SELECT day, upstream_total_tokens, requests, upstream_usage_reports, upstream_usage_missing
       FROM ${TABLE_DAILY}
       WHERE day >= ?
       ORDER BY day`
    ).bind(startDayIso).all<UpstreamDailyRow>();
    dailyRows = Array.isArray(res?.results) ? res.results : [];
    dailyTableHasData = dailyRows.length > 0;
  } catch {
    dailyRows = [];
  }

  for (const r of dailyRows) {
    if (!r || typeof r.day !== 'string') continue;
    map.set(r.day, {
      total: Number(r.upstream_total_tokens) || 0,
      requests: Number(r.requests) || 0,
      reports: Number(r.upstream_usage_reports) || 0,
      missing: Number(r.upstream_usage_missing) || 0,
    });
  }

  const recentStartMs = utc8DayStartUtcMs(now) - 6 * DAY_MS;
  const recentStartIso = isoDayUtc8(recentStartMs);
  const hourlyStartDayIso = dailyTableHasData
    ? (startDayIso > recentStartIso ? startDayIso : recentStartIso)
    : startDayIso;
  const hourlyStartUtcMs = Date.parse(`${hourlyStartDayIso}T00:00:00Z`) - DISPLAY_TIMEZONE_OFFSET_MS;
  const hourlyStart = normalizeHour(hourlyStartUtcMs);

  try {
    const res = await d1.prepare(
      `SELECT hour, upstream_total_tokens, requests, upstream_usage_reports, upstream_usage_missing
       FROM ${TABLE}
       WHERE hour >= ?
       ORDER BY hour`
    ).bind(hourlyStart).all<UpstreamHourlyRow>();
    const rows = Array.isArray(res?.results) ? res.results : [];
    const hourlyByDay = new Map<string, UpstreamDailyWindowRow>();
    for (const r of rows) {
      if (!r || typeof r.hour !== 'string') continue;
      const ms = Date.parse(r.hour);
      if (!Number.isFinite(ms)) continue;
      const day = isoDayUtc8(ms);
      if (day < hourlyStartDayIso || day < startDayIso) continue;
      const cur = hourlyByDay.get(day) || { total: 0, requests: 0, reports: 0, missing: 0 };
      hourlyByDay.set(day, {
        total: cur.total + (Number(r.upstream_total_tokens) || 0),
        requests: cur.requests + (Number(r.requests) || 0),
        reports: cur.reports + (Number(r.upstream_usage_reports) || 0),
        missing: cur.missing + (Number(r.upstream_usage_missing) || 0),
      });
    }
    for (const [day, value] of hourlyByDay) map.set(day, value);
  } catch (e) {
    if (!dailyTableHasData) return { available: false, error: `loadUpstreamDaily: ${asMessage(e)}` };
  }
  return map;
}

export async function loadUpstreamModels(env: GatewayEnv, days: number = 7, now: number = Date.now()): Promise<{ available: true, rows: Array<{ model: string, total: number, requests: number }> } | { available: false, error: string }> {
  const d1 = tokenStatsD1(env);
  if (!d1) return { available: false, error: 'TOKEN_STATS_DB binding missing' };
  const startHour = normalizeHour(now - days * DAY_MS);
  try {
    const res = await d1.prepare(
      `SELECT LOWER(TRIM(model)) AS model,
              COALESCE(SUM(upstream_total_tokens), 0) AS total,
              COALESCE(SUM(upstream_attempts), 0) AS attempts
       FROM ${TABLE_MODEL}
       WHERE hour >= ?
       GROUP BY LOWER(TRIM(model))
       ORDER BY total DESC`
    ).bind(startHour).all<UpstreamModelRow>();
    const rows = Array.isArray(res?.results) ? res.results : [];
    return {
      available: true,
      rows: rows
        .map((r) => ({ model: normalizeModelKey(r?.model), total: Number(r?.total) || 0, requests: Number(r?.attempts) || 0 }))
        .filter((r) => r.model.length > 0),
    };
  } catch (e) {
    return { available: false, error: `loadUpstreamModels: ${asMessage(e)}` };
  }
}
