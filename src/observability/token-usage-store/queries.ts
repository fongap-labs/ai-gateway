import type { GatewayEnv } from '../../types/runtime.ts';
import { flushBeforeRead } from './buffer.ts';
import {
  DAY_MS,
  DISPLAY_TIMEZONE_OFFSET_MS,
  HOUR_MS,
  isoDayUtc8,
  normalizeHour,
  normalizeModelKey,
  TABLE,
  TABLE_DAILY,
  TABLE_MODEL,
  TABLE_TOTALS,
  TTFT_BUCKET_BOUNDARIES_MS,
  tokenStatsD1,
  utc8DayStartUtcMs,
} from './keys.ts';

type DailyWindowRow = { total: number; requests: number; reports: number; missing: number };
type TtftEntry = { available: true; p50: number | null; p95: number | null; sampleCount: number; p50Insufficient: boolean; p95Insufficient: boolean };
type NumericCell = number | null;
type TotalsRow = {
  total_tokens?: NumericCell;
  requests?: NumericCell;
  usage_reports?: NumericCell;
  usage_missing?: NumericCell;
};
type SummaryWindowRow = {
  today_total?: NumericCell;
  today_requests?: NumericCell;
  h24_total?: NumericCell;
  h24_requests?: NumericCell;
  d7_total?: NumericCell;
  d7_requests?: NumericCell;
};
type SummaryFallbackRow = { t?: NumericCell; r?: NumericCell; rp?: NumericCell; rm?: NumericCell };
type DailyRow = {
  day: string;
  total_tokens?: NumericCell;
  requests?: NumericCell;
  usage_reports?: NumericCell;
  usage_missing?: NumericCell;
};
type HourlyDailyRow = {
  hour: string;
  total?: NumericCell;
  requests?: NumericCell;
  reports?: NumericCell;
  missing?: NumericCell;
};
type ModelUsageRow = { model?: string | null; total?: NumericCell; requests?: NumericCell };
type ModelKeyRow = { model?: string | null };
type TtftRow = {
  model?: string | null;
  total_ttft?: NumericCell;
  b0?: NumericCell;
  b1?: NumericCell;
  b2?: NumericCell;
  b3?: NumericCell;
  b4?: NumericCell;
  b5?: NumericCell;
  b6?: NumericCell;
};
type CoverageRow = {
  model?: string | null;
  requests?: NumericCell;
  reports?: NumericCell;
  missing?: NumericCell;
};

const asMessage = (e: unknown): string => String((e as { message?: unknown } | null | undefined)?.message || e);

export async function queryTokenSummary(
  env: GatewayEnv,
  now: number = Date.now(),
): Promise<
  | {
      available: true;
      today: { total: number; requests: number };
      h24: { total: number; requests: number };
      d7: { total: number; requests: number };
      cumulative: { total: number; requests: number; reports: number; missing: number };
      coverage: number | null;
    }
  | { available: false; error: string }
  | null
> {
  await flushBeforeRead();
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  const todayStart = normalizeHour(utc8DayStartUtcMs(now));
  const h24Start = normalizeHour(now - 24 * HOUR_MS);
  const d7Start = normalizeHour(now - 7 * DAY_MS);

  let totalsRow: TotalsRow | null = null;
  try {
    const totalsStmt = d1.prepare(
      `SELECT input_tokens, output_tokens, total_tokens, requests, usage_reports, usage_missing
       FROM ${TABLE_TOTALS} WHERE scope = 'global'`,
    );
    totalsRow = await totalsStmt.first<TotalsRow>();
  } catch (_e) {}

  const hourlyStmt = d1.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN hour >= ? THEN total_tokens END), 0) AS today_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN requests END), 0) AS today_requests,
       COALESCE(SUM(CASE WHEN hour >= ? THEN total_tokens END), 0) AS h24_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN requests END), 0) AS h24_requests,
       COALESCE(SUM(CASE WHEN hour >= ? THEN total_tokens END), 0) AS d7_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN requests END), 0) AS d7_requests
     FROM ${TABLE}`,
  );
  let hourlyRow: SummaryWindowRow | null | undefined;
  try {
    hourlyRow = await hourlyStmt.bind(todayStart, todayStart, h24Start, h24Start, d7Start, d7Start).first<SummaryWindowRow>();
  } catch (e) {
    return { available: false, error: `queryTokenSummary: ${asMessage(e)}` };
  }
  if (!hourlyRow || typeof hourlyRow !== 'object') return null;

  let cum_total: number, cum_requests: number, cum_reports: number, cum_missing: number;
  if (totalsRow && typeof totalsRow === 'object') {
    cum_total = Number(totalsRow.total_tokens) || 0;
    cum_requests = Number(totalsRow.requests) || 0;
    cum_reports = Number(totalsRow.usage_reports) || 0;
    cum_missing = Number(totalsRow.usage_missing) || 0;
  } else {
    try {
      const fallbackStmt = d1.prepare(
        `SELECT COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(requests),0) AS r,
                COALESCE(SUM(usage_reports),0) AS rp, COALESCE(SUM(usage_missing),0) AS rm
         FROM ${TABLE}`,
      );
      const fb = await fallbackStmt.first<SummaryFallbackRow>();
      if (fb) {
        cum_total = Number(fb.t) || 0;
        cum_requests = Number(fb.r) || 0;
        cum_reports = Number(fb.rp) || 0;
        cum_missing = Number(fb.rm) || 0;
      } else {
        cum_total = cum_requests = cum_reports = cum_missing = 0;
      }
    } catch (_e) {
      cum_total = cum_requests = cum_reports = cum_missing = 0;
    }
  }

  const reports = cum_reports;
  const missing = cum_missing;
  const denominator = reports + missing;
  return {
    available: true,
    today: {
      total: Number(hourlyRow.today_total) || 0,
      requests: Number(hourlyRow.today_requests) || 0,
    },
    cumulative: {
      total: cum_total,
      requests: cum_requests,
      reports,
      missing,
    },
    h24: {
      total: Number(hourlyRow.h24_total) || 0,
      requests: Number(hourlyRow.h24_requests) || 0,
    },
    d7: {
      total: Number(hourlyRow.d7_total) || 0,
      requests: Number(hourlyRow.d7_requests) || 0,
    },
    coverage: denominator === 0 ? null : reports / denominator,
  };
}

export async function queryTokenDailySeries(
  env: GatewayEnv,
  startDayIso: string,
  now: number = Date.now(),
): Promise<Map<string, DailyWindowRow> | { available: false; error: string } | null> {
  await flushBeforeRead();
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  const map = new Map<string, DailyWindowRow>();
  let dailyRows: DailyRow[] = [];
  let hasDailyTableData = false;

  try {
    const res = await d1
      .prepare(
        `SELECT day, input_tokens, output_tokens, total_tokens, requests, usage_reports, usage_missing
       FROM ${TABLE_DAILY}
       WHERE day >= ?
       ORDER BY day`,
      )
      .bind(startDayIso)
      .all<DailyRow>();
    dailyRows = Array.isArray(res?.results) ? res.results : [];
    hasDailyTableData = dailyRows.length > 0;
  } catch (_e) {
    dailyRows = [];
    hasDailyTableData = false;
  }

  for (const r of dailyRows) {
    if (!r || typeof r.day !== 'string') continue;
    map.set(r.day, {
      total: Number(r.total_tokens) || 0,
      requests: Number(r.requests) || 0,
      reports: Number(r.usage_reports) || 0,
      missing: Number(r.usage_missing) || 0,
    });
  }

  const recentStartMs = utc8DayStartUtcMs(now) - 6 * DAY_MS;
  const recentStartIso = isoDayUtc8(recentStartMs);
  const hourlyStartDayIso = hasDailyTableData ? (startDayIso > recentStartIso ? startDayIso : recentStartIso) : startDayIso;
  const hourlyStartUtcMs = Date.parse(`${hourlyStartDayIso}T00:00:00Z`) - DISPLAY_TIMEZONE_OFFSET_MS;
  const hourlyStart = normalizeHour(hourlyStartUtcMs);

  try {
    const res = await d1
      .prepare(
        `SELECT hour, COALESCE(SUM(total_tokens),0) AS total, COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(usage_reports),0) AS reports, COALESCE(SUM(usage_missing),0) AS missing
       FROM ${TABLE}
       WHERE hour >= ?
       GROUP BY hour`,
      )
      .bind(hourlyStart)
      .all<HourlyDailyRow>();
    const rows = Array.isArray(res?.results) ? res.results : [];
    const hourlyByDay = new Map<string, DailyWindowRow>();

    for (const r of rows) {
      if (!r || typeof r.hour !== 'string') continue;
      const ms = Date.parse(r.hour);
      if (!Number.isFinite(ms)) continue;
      const day = isoDayUtc8(ms);
      if (day < hourlyStartDayIso || day < startDayIso) continue;
      const cur = hourlyByDay.get(day) || { total: 0, requests: 0, reports: 0, missing: 0 };
      hourlyByDay.set(day, {
        total: cur.total + (Number(r.total) || 0),
        requests: cur.requests + (Number(r.requests) || 0),
        reports: cur.reports + (Number(r.reports) || 0),
        missing: cur.missing + (Number(r.missing) || 0),
      });
    }

    for (const [day, value] of hourlyByDay) map.set(day, value);
  } catch (e) {
    if (!hasDailyTableData) {
      return { available: false, error: `queryTokenDailySeries: ${asMessage(e)}` };
    }
  }

  return map;
}

export async function queryTokenModelUsage(
  env: GatewayEnv,
  days: number = 7,
  now: number = Date.now(),
): Promise<{ available: true; rows: Array<{ model: string; total: number; requests: number }> } | { available: false; error: string }> {
  await flushBeforeRead();
  const d1 = tokenStatsD1(env);
  if (!d1) return { available: false, error: 'TOKEN_STATS_DB binding missing' };
  const startHour = normalizeHour(now - days * DAY_MS);
  try {
    const res = await d1
      .prepare(
        `SELECT LOWER(TRIM(model)) AS model,
              COALESCE(SUM(total_tokens), 0) AS total,
              COALESCE(SUM(requests), 0) AS requests
       FROM ${TABLE_MODEL}
       WHERE hour >= ?
       GROUP BY LOWER(TRIM(model))
       ORDER BY total DESC`,
      )
      .bind(startHour)
      .all<ModelUsageRow>();
    const rows = Array.isArray(res?.results) ? res.results : [];
    return {
      available: true,
      rows: rows
        .map((r) => ({ model: normalizeModelKey(r?.model), total: Number(r?.total) || 0, requests: Number(r?.requests) || 0 }))
        .filter((r) => r.model.length > 0),
    };
  } catch (e) {
    return { available: false, error: `queryTokenModelUsage: ${asMessage(e)}` };
  }
}

export const MODEL_STATUS_RECENT_WINDOW_MS = 24 * HOUR_MS;

export const MODEL_STATUS_HISTORICAL_WINDOW_MS = 7 * DAY_MS;

export async function queryRecentModelEvidence(
  env: GatewayEnv,
  windowMs: number = MODEL_STATUS_RECENT_WINDOW_MS,
  now: number = Date.now(),
): Promise<Set<string>> {
  await flushBeforeRead();
  const d1 = tokenStatsD1(env);
  if (!d1) return new Set();
  const startHour = normalizeHour(now - windowMs);
  try {
    const res = await d1
      .prepare(
        `SELECT LOWER(TRIM(model)) AS model
       FROM ${TABLE_MODEL}
       WHERE hour >= ? AND requests > 0
       GROUP BY LOWER(TRIM(model))`,
      )
      .bind(startHour)
      .all<ModelKeyRow>();
    const rows = Array.isArray(res?.results) ? res.results : [];
    const out = new Set<string>();
    for (const r of rows) {
      const key = normalizeModelKey(r?.model);
      if (key) out.add(key);
    }
    return out;
  } catch (_e) {
    return new Set();
  }
}

export async function queryAllModelsTtftPercentiles(env: GatewayEnv, windowMs: number = MODEL_STATUS_RECENT_WINDOW_MS, now: number = Date.now()) {
  await flushBeforeRead();
  const d1 = tokenStatsD1(env);
  if (!d1) return { available: false, error: 'TOKEN_STATS_DB binding missing' };
  const startHour = normalizeHour(now - windowMs);
  try {
    const res = await d1
      .prepare(
        `SELECT LOWER(TRIM(model)) AS model,
              COALESCE(SUM(successful_ttft_count), 0) AS total_ttft,
              COALESCE(SUM(ttft_b0), 0) AS b0,
              COALESCE(SUM(ttft_b1), 0) AS b1,
              COALESCE(SUM(ttft_b2), 0) AS b2,
              COALESCE(SUM(ttft_b3), 0) AS b3,
              COALESCE(SUM(ttft_b4), 0) AS b4,
              COALESCE(SUM(ttft_b5), 0) AS b5,
              COALESCE(SUM(ttft_b6), 0) AS b6
       FROM ${TABLE_MODEL}
       WHERE hour >= ?
       GROUP BY LOWER(TRIM(model))`,
      )
      .bind(startHour)
      .all<TtftRow>();
    const rows = Array.isArray(res?.results) ? res.results : [];
    const ttft = new Map<string, TtftEntry>();
    for (const row of rows) {
      const key = normalizeModelKey(row?.model);
      if (!key) continue;
      const total = Number(row.total_ttft) || 0;
      if (total < TTFT_P50_MIN_SAMPLES) {
        ttft.set(key, { available: true, p50: null, p95: null, sampleCount: total, p50Insufficient: true, p95Insufficient: true });
        continue;
      }
      const buckets = [
        Number(row.b0) || 0,
        Number(row.b1) || 0,
        Number(row.b2) || 0,
        Number(row.b3) || 0,
        Number(row.b4) || 0,
        Number(row.b5) || 0,
        Number(row.b6) || 0,
      ];
      ttft.set(key, {
        available: true,
        p50: percentileFromBuckets(buckets, total, 0.5),
        p95: total >= TTFT_P95_MIN_SAMPLES ? percentileFromBuckets(buckets, total, 0.95) : null,
        sampleCount: total,
        p50Insufficient: false,
        p95Insufficient: total < TTFT_P95_MIN_SAMPLES,
      });
    }
    return { available: true, ttft };
  } catch (e) {
    return { available: false, error: `queryAllModelsTtftPercentiles: ${asMessage(e)}` };
  }
}

const TTFT_P50_MIN_SAMPLES = 5;
const TTFT_P95_MIN_SAMPLES = 20;

function percentileFromBuckets(buckets: number[], total: number, pct: number): number {
  const threshold = Math.ceil(total * pct);
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    cumulative += buckets[i] ?? 0;
    if (cumulative >= threshold) {
      return TTFT_BUCKET_BOUNDARIES_MS[i] ?? Infinity;
    }
  }
  return Infinity;
}

export async function queryModelUsageCoverage(env: GatewayEnv, days: number = 7, now: number = Date.now()) {
  await flushBeforeRead();
  const d1 = tokenStatsD1(env);
  if (!d1) return { available: false, error: 'TOKEN_STATS_DB binding missing' };
  const startHour = normalizeHour(now - days * DAY_MS);
  try {
    const res = await d1
      .prepare(
        `SELECT LOWER(TRIM(model)) AS model,
              COALESCE(SUM(requests), 0) AS requests,
              COALESCE(SUM(usage_reports), 0) AS reports,
              COALESCE(SUM(usage_missing), 0) AS missing
       FROM ${TABLE_MODEL}
       WHERE hour >= ?
       GROUP BY LOWER(TRIM(model))
       ORDER BY requests DESC`,
      )
      .bind(startHour)
      .all<CoverageRow>();
    const rows = Array.isArray(res?.results) ? res.results : [];
    return {
      available: true,
      rows: rows
        .map((r) => {
          const requests = Number(r?.requests) || 0;
          const reports = Number(r?.reports) || 0;
          const missing = Number(r?.missing) || 0;
          const denominator = reports + missing;
          return {
            model: normalizeModelKey(r?.model),
            requests,
            reports,
            missing,
            usageCoverage: denominator === 0 ? null : reports / denominator,
          };
        })
        .filter((r) => r.model.length > 0),
    };
  } catch (e) {
    return { available: false, error: `queryModelUsageCoverage: ${asMessage(e)}` };
  }
}
