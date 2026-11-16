import type { D1Database } from '../contracts/cloudflare.ts';
import type { GatewayEnv } from '../contracts/runtime.ts';

export const TABLE = 'token_usage_hourly';
export const TABLE_MODEL = 'token_usage_model_hourly';
export const TABLE_TOTALS = 'token_usage_totals';
export const TABLE_DAILY = 'token_usage_daily';
export const TABLE_WEEKLY = 'token_usage_weekly';

export const HOUR_MS = 3600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

export const HOURLY_RETENTION_MS = 7 * DAY_MS;
export const DAILY_RETENTION_MS = 52 * WEEK_MS;
export const WEEKLY_RETENTION_MS = 52 * WEEK_MS;

export const TTFT_BUCKET_BOUNDARIES_MS = [100, 500, 1000, 2000, 5000, 10000];
export const TTFT_BUCKET_COUNT = 7;

export const DISPLAY_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1000;

export function utc8DayStartUtcMs(now: number = Date.now()): number {
  return Math.floor((now + DISPLAY_TIMEZONE_OFFSET_MS) / DAY_MS) * DAY_MS - DISPLAY_TIMEZONE_OFFSET_MS;
}

export function isoDayUtc8(ms: number): string {
  return new Date(ms + DISPLAY_TIMEZONE_OFFSET_MS).toISOString().slice(0, 10);
}

export function normalizeHour(date: number | Date = Date.now()): string {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:00:00Z`;
}

export function ttftBucketIndex(ttftMs: number): number {
  if (ttftMs === Infinity) return TTFT_BUCKET_COUNT - 1;
  if (!Number.isFinite(ttftMs) || ttftMs < 0) return -1;
  for (let i = 0; i < TTFT_BUCKET_BOUNDARIES_MS.length; i++) {
    const boundary = TTFT_BUCKET_BOUNDARIES_MS[i];
    if (boundary !== undefined && ttftMs < boundary) return i;
  }
  return TTFT_BUCKET_COUNT - 1;
}

export function normalizeModelKey(model: unknown): string {
  return String(model || '')
    .trim()
    .toLowerCase();
}

export function tokenStatsD1(env: GatewayEnv | null | undefined): D1Database | null {
  const d1 = env?.TOKEN_STATS_DB;
  if (!d1 || typeof d1.prepare !== 'function') {
    return null;
  }
  return d1;
}
