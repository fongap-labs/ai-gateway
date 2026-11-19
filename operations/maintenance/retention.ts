import type { GatewayEnv } from '../../packages/contracts/runtime.ts';
import { flushUsageBuffer } from '../../packages/usage-store/buffer.ts';
import {
  DAILY_RETENTION_MS,
  DAY_MS,
  HOURLY_RETENTION_MS,
  normalizeHour,
  TABLE,
  TABLE_DAILY,
  TABLE_MODEL,
  TABLE_WEEKLY,
  tokenStatsD1,
  WEEK_MS,
  WEEKLY_RETENTION_MS,
} from '../../packages/usage-store/keys.ts';
import { getUtcWeekStartUtcMs } from '../../packages/usage-store/time-buckets.ts';

const HOURLY_RETENTION_DAYS = HOURLY_RETENTION_MS / DAY_MS;
const DAILY_RETENTION_WEEKS = DAILY_RETENTION_MS / WEEK_MS;
const WEEKLY_RETENTION_WEEKS = WEEKLY_RETENTION_MS / WEEK_MS;
const MODEL_STATS_RETENTION_DAYS = 7;

export async function cleanupUsageRetention(env: GatewayEnv, now: number = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  const results: Record<string, unknown> = {};

  const hourlyCutoff = normalizeHour(now - HOURLY_RETENTION_DAYS * DAY_MS);
  try {
    const res = await d1.prepare(`DELETE FROM ${TABLE} WHERE hour < ?`).bind(hourlyCutoff).run();
    results.hourly = { deleted: res?.meta?.changes ?? 0, cutoff: hourlyCutoff };
  } catch (e) {
    results.hourly = { error: (e as { message?: unknown } | null | undefined)?.message || e };
  }

  const currentWeekStart = getUtcWeekStartUtcMs(now);
  const dailyCutoffMs = currentWeekStart - (DAILY_RETENTION_WEEKS - 1) * WEEK_MS;
  const dailyCutoff = new Date(dailyCutoffMs).toISOString().slice(0, 10);
  try {
    const res = await d1.prepare(`DELETE FROM ${TABLE_DAILY} WHERE day < ?`).bind(dailyCutoff).run();
    results.daily = { deleted: res?.meta?.changes ?? 0, cutoff: dailyCutoff };
  } catch (e) {
    results.daily = { error: (e as { message?: unknown } | null | undefined)?.message || e };
  }

  const weeklyCutoffMs = currentWeekStart - (WEEKLY_RETENTION_WEEKS - 1) * WEEK_MS;
  const weeklyCutoff = new Date(weeklyCutoffMs).toISOString().slice(0, 10);
  try {
    const res = await d1.prepare(`DELETE FROM ${TABLE_WEEKLY} WHERE week_start < ?`).bind(weeklyCutoff).run();
    results.weekly = { deleted: res?.meta?.changes ?? 0, cutoff: weeklyCutoff };
  } catch (e) {
    results.weekly = { error: (e as { message?: unknown } | null | undefined)?.message || e };
  }

  console.log('token-stats retention cleanup:', JSON.stringify(results));
  return results;
}

export async function cleanupModelStats(env: GatewayEnv) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  const cutoffHour = normalizeHour(Date.now() - MODEL_STATS_RETENTION_DAYS * DAY_MS);
  try {
    const res = await d1.prepare(`DELETE FROM ${TABLE_MODEL} WHERE hour < ?`).bind(cutoffHour).run();
    const deleted = res?.meta?.changes ?? 0;
    console.log(`token-stats cleanup: deleted ${deleted} model-usage rows older than ${cutoffHour}`);
    return { deleted, cutoffHour };
  } catch (e) {
    const error = (e as { message?: unknown } | null | undefined)?.message || e;
    console.error('token-stats cleanup failed:', error);
    return { error };
  }
}

export async function maintainUsageStats(env: GatewayEnv, now: number = Date.now()) {
  await flushUsageBuffer().catch((e) => console.error('token-stats flush before maintenance failed:', e?.message || e));
  const { aggregateHourlyToDaily, aggregateDailyToWeekly } = await import('./aggregation.ts');
  const aggDaily = await aggregateHourlyToDaily(env, now).catch((e) => ({ error: e?.message || e }));
  const aggWeekly = await aggregateDailyToWeekly(env, now).catch((e) => ({ error: e?.message || e }));
  const aggregationFailed = 'error' in aggDaily || 'error' in aggWeekly;
  const cleanup = aggregationFailed
    ? { skipped: true, reason: 'aggregation failed; retention cleanup deferred' }
    : await cleanupUsageRetention(env, now).catch((e) => ({ error: e?.message || e }));
  const modelCleanup = await cleanupModelStats(env);
  return { aggDaily, aggWeekly, cleanup, modelCleanup };
}
