// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import {
  loadUpstreamSummary,
  loadUpstreamDaily,
  loadUpstreamModels,
  normalizeModelKey,
  utc8DayStartUtcMs,
  isoDayUtc8,
} from '../observability/token-usage-store.ts';
import { escapeHtml, fmtTokens, fmtInt } from './format.ts';
import { buildCalendarHeatmap } from './heatmap.ts';
import { renderHeatmap } from './heatmap-view.ts';
import type { HeatmapDataEntry } from './heatmap.ts';
import type { DailyCellData } from './heatmap-view.ts';
import type { TtftEntry } from './model-status-view.ts';

const DAY_MS = 86_400_000;
const HEATMAP_WEEKS = 52;
const BRAND_SHADES = ['#0f5d53', '#3f8b7c', '#7cb4a5', '#a9d0c4', '#c0d9d1'];

function modelShade(i: number): string {
  const index = Math.min(i, BRAND_SHADES.length - 1);
  return BRAND_SHADES[index] ?? '#0f5d53';
}

export function buildHeatmap(daily: Map<string, DailyCellData> | null, now: number, coverage?: number | null): { cells: string[], labels: string[], ariaLabel: string, weekCount: number } {
  const heatmap = buildCalendarHeatmap({
    mode: 'rolling-52-weeks',
    today: now,
    data: daily,
    valueKey: 'total',
  });
  const { cells, labels, ariaLabel } = renderHeatmap(heatmap, {
    data: daily,
    valueKey: 'total',
    coverage,
    countLabel: '次请求',
  });
  return { cells, labels, ariaLabel, weekCount: heatmap.weeks.length };
}

function statCell(value: string, label: string): string {
  const exact = typeof value === 'string' && /^[\d,]+$/.test(value) ? Number(value.replace(/,/g, '')) : null;
  const titleAttr = exact !== null ? ` title="${escapeHtml(fmtInt(exact))}"` : '';
  return `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value"${titleAttr}>${value}</div></div>`;
}

function pct(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0 || part <= 0) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

function renderTokenComposition(cumulative: SummaryCumulative): string {
  const totalActivity = cumulative.input + cumulative.cacheRead + cumulative.output;
  const inputPct = pct(cumulative.input, totalActivity);
  const cachePct = pct(cumulative.cacheRead, totalActivity);
  const outputPct = pct(cumulative.output, totalActivity);
  const hasCacheRead = cumulative.cacheReadReports > 0;
  const cachePercent = cumulative.cacheHitRatio == null
    ? null
    : Math.max(0, Math.min(100, cumulative.cacheHitRatio * 100));
  const cacheRatio = cachePercent == null ? '—' : `${cachePercent.toFixed(1)}%`;
  const cacheReadValue = hasCacheRead || cumulative.cacheRead > 0 ? fmtTokens(cumulative.cacheRead) : '—';
  const cacheTitle = '累计缓存读取 Token';
  return `<div class="composition-card" aria-label="累计 Token 统计">
    <div class="composition-data">
      <div class="composition-track" aria-hidden="true">
        <i class="composition-input" style="width:${inputPct}%"></i>
        <i class="composition-cache" style="width:${cachePct}%"></i>
        <i class="composition-output" style="width:${outputPct}%"></i>
      </div>
      <div class="composition-metrics four-up">
        <div class="composition-metric metric-left" title="${escapeHtml(cacheTitle)}">
          <div class="composition-label">缓存读取占比</div>
          <strong>${cacheRatio}</strong>
          <small>缓存命中率</small>
        </div>
        <div class="composition-metric metric-center" title="累计输入 Token">
          <div class="composition-label"><i class="metric-dot input"></i>输入 Token</div>
          <strong>${fmtTokens(cumulative.input)}</strong>
          <small>${inputPct.toFixed(1)}%</small>
        </div>
        <div class="composition-metric metric-center" title="累计输出 Token">
          <div class="composition-label"><i class="metric-dot output"></i>输出 Token</div>
          <strong>${fmtTokens(cumulative.output)}</strong>
          <small>${outputPct.toFixed(1)}%</small>
        </div>
        <div class="composition-metric metric-right" title="${escapeHtml(cacheTitle)}">
          <div class="composition-label"><i class="metric-dot cache"></i>缓存读取 Token</div>
          <strong>${cacheReadValue}</strong>
          <small>${cachePct.toFixed(1)}%</small>
        </div>
      </div>
    </div>
  </div>`;
}

type ModelUsageRow = { model: string, total: number, requests: number };

function renderBars(rows: ModelUsageRow[]): string {
  const total = rows.reduce((s, r) => s + r.total, 0);
  const items = rows.map((r, i) => {
    const share = total > 0 ? (r.total / total) * 100 : 0;
    const width = total > 0 ? Math.max(2, share) : 0;
    const exactTitle = `${r.model}\n${fmtTokens(r.total)} Token · ${fmtInt(r.requests)} 次请求 · ${share.toFixed(1)}%`;
    return `<div class="model-rank-row" style="--c:${modelShade(i)};--w:${width.toFixed(1)}%" data-tooltip="${escapeHtml(exactTitle)}" tabindex="0" aria-label="${escapeHtml(exactTitle)}">
      <div class="model-rank-index">${i + 1}</div>
      <div class="model-rank-name">${escapeHtml(r.model)}</div>
      <div class="model-rank-bar"><i></i></div>
      <div class="model-rank-value">${fmtTokens(r.total)}</div>
      <div class="model-rank-share">${share.toFixed(1)}%</div>
    </div>`;
  }).join('');
  return `<div class="model-ranking">${items}</div>`;
}

type ModelUsageResult = { available?: boolean, rows?: ModelUsageRow[], error?: string };

function dashboardModelAllowlist(raw: unknown): Map<string, string> | null {
  const configured = typeof raw === 'string' ? raw.trim() : '';
  if (!configured) return null;
  const out = new Map<string, string>();
  for (const token of configured.split(',')) {
    const display = token.trim();
    const key = normalizeModelKey(display);
    if (key && !out.has(key)) out.set(key, display);
  }
  return out.size ? out : null;
}

export function selectDashboardModelUsageRows(
  rows: ModelUsageRow[] | null | undefined,
  rawDashboardModels: unknown,
  officialNames: Map<string, string> | null | undefined,
): ModelUsageRow[] {
  const allowlist = dashboardModelAllowlist(rawDashboardModels);
  const eligible = new Map<string, { total: number, requests: number }>();
  let otherTotal = 0;
  let otherRequests = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const key = normalizeModelKey(row?.model);
    if (!key) continue;
    const total = Number(row?.total) || 0;
    const requests = Number(row?.requests) || 0;
    if (allowlist && !allowlist.has(key)) {
      otherTotal += total;
      otherRequests += requests;
      continue;
    }
    const current = eligible.get(key) || { total: 0, requests: 0 };
    current.total += total;
    current.requests += requests;
    eligible.set(key, current);
  }

  const ranked = [...eligible.entries()]
    .map(([model, stats]) => ({ model, ...stats }))
    .sort((a, b) => b.total - a.total || b.requests - a.requests || a.model.localeCompare(b.model));

  for (const row of ranked.slice(3)) {
    otherTotal += row.total;
    otherRequests += row.requests;
  }

  const displayName = (key: string): string =>
    (officialNames instanceof Map && officialNames.get(key)) || allowlist?.get(key) || key;
  const result = ranked.slice(0, 3).map((row) => ({ ...row, model: displayName(row.model) }));
  if (otherTotal > 0 || otherRequests > 0) {
    result.push({ model: '其他', total: otherTotal, requests: otherRequests });
  }
  return result;
}

function renderModelUsage(
  modelUsage: ModelUsageResult | null | undefined,
  officialNames: Map<string, string> | null | undefined,
  rawDashboardModels: unknown,
): string {
  const rows = modelUsage?.available === false
    ? []
    : selectDashboardModelUsageRows(modelUsage?.rows, rawDashboardModels, officialNames);
  const body = rows.length
    ? renderBars(rows)
    : `<div class="model-usage-empty">${modelUsage?.available === false ? '—' : '近 7 天暂无数据'}</div>`;

  return `<div class="usage-panel model-panel">
    <div class="panel-head">
      <div>
        <div class="panel-title">模型使用 · 近 7 天</div>
      </div>
    </div>
    ${body}
  </div>`;
}

function isSummaryAvailable(s: SummaryResult | null): s is Extract<SummaryResult, { available: true }> {
  return s != null && s.available === true;
}
function isSummaryError(s: SummaryResult | null): s is { available: false, error: string } {
  return s != null && s.available === false;
}
function isDailyAvailable(d: DailyResult | null): d is Map<string, HeatmapDataEntry> {
  return d instanceof Map;
}
function isDailyError(d: DailyResult | null): d is { available: false, error: string } {
  return d != null && !(d instanceof Map);
}
function dailyErrorMessage(d: DailyResult | null): string | undefined { return isDailyError(d) ? d.error : undefined; }
function summaryErrorMessage(s: SummaryResult | null): string | undefined { return isSummaryError(s) ? s.error : undefined; }

export async function usageSection(env: Record<string, unknown>, now: number = Date.now(), stats: DashboardStats | null = null, officialNames: Map<string, string> | null = null): Promise<string> {
  const cache = stats || await getCachedDashboardStats(env, now);
  const { summary, daily, modelUsage } = cache;
  const summaryOk = isSummaryAvailable(summary);
  const dailyOk = isDailyAvailable(daily);
  const dailyMap = dailyOk ? daily : null;

  const kpis = summaryOk
    ? [
        statCell(fmtTokens(summary.today.total), '今日'),
        statCell(fmtTokens(summary.h24.total), '24 小时'),
        statCell(fmtTokens(summary.d7.total), '7 天'),
        statCell(fmtTokens(summary.cumulative.total), '累计'),
      ].join('')
    : [statCell('—', '今日'), statCell('—', '24 小时'), statCell('—', '7 天'), statCell('—', '累计')].join('');

  let totalAttempts = 0;
  if (dailyMap) for (const v of dailyMap.values()) totalAttempts += v.requests;

  const errors: string[] = [];
  if (summaryErrorMessage(summary)) errors.push(summaryErrorMessage(summary) as string);
  if (dailyErrorMessage(daily)) errors.push(dailyErrorMessage(daily) as string);
  if (!summary) errors.push('TOKEN_STATS_DB binding missing');
  if (isSummaryError(summary) && !summary.error) errors.push('summary unavailable');
  if (isDailyError(daily) && !daily.error) errors.push('daily unavailable');
  if (errors.length && env && env.LOG_LEVEL !== 'none') {
    try { console.warn(`[dashboard D1 degraded] ${errors.join('; ')}`); } catch {}
  }

  const activity = dailyMap
    ? (() => {
        const { cells, labels, ariaLabel, weekCount } = buildHeatmap(dailyMap as Map<string, DailyCellData>, now, summaryOk ? summary.coverage : null);
        const weekTracks = `--week-count:${weekCount}`;
        return `<div class="heatmap-wrap" tabindex="0" role="img" aria-label="${escapeHtml(ariaLabel)}">` +
          `<div class="heatmap" style="${weekTracks}" aria-hidden="true">${cells.join('')}</div>` +
          `<div class="months" style="${weekTracks}" aria-hidden="true">${labels.join('')}</div></div>`;
      })()
    : `<div class="model-usage-empty">统计暂不可用</div>`;

  const activityPanel = `<div class="usage-panel activity-panel">
    <div class="panel-head">
      <div>
        <div class="panel-title">Token 活动 · 近 52 周</div>
      </div>
      <div class="panel-meta">${fmtInt(totalAttempts)} 次请求</div>
    </div>
    ${activity}
  </div>`;

  return `<section id="usage">
  <div class="wrap">
    <div class="section-head"><span class="section-title">使用情况</span></div>
    <div class="stat-row">${kpis}</div>
    ${summaryOk ? renderTokenComposition(summary.cumulative) : ''}
    <div class="usage-detail-grid">
      ${activityPanel}
      ${renderModelUsage(modelUsage, officialNames, env?.AIG_DASHBOARD_MODELS)}
    </div>
  </div>
</section>`;
}

import { MODEL_STATUS_RECENT_WINDOW_MS, MODEL_STATUS_HISTORICAL_WINDOW_MS, queryAllModelsTtftPercentiles, queryRecentModelEvidence } from '../observability/token-usage-store.ts';

type SummaryBucket = { total: number, requests: number };
type SummaryH24 = SummaryBucket & { input: number, output: number, cacheRead: number, cacheReadReports: number, cacheHitRatio: number | null };
type SummaryCumulative = SummaryBucket & { reports: number, missing: number, input: number, output: number, cacheRead: number, cacheReadReports: number, cacheHitRatio: number | null };
type SummaryResult = ({
  available: true,
  today: SummaryBucket,
  h24: SummaryH24,
  d7: SummaryBucket,
  cumulative: SummaryCumulative,
  coverage: number | null,
} | { available: false, error: string });
type DailyResult = Map<string, HeatmapDataEntry> | { available: false, error: string };

export type DashboardStats = {
  summary: SummaryResult | null,
  daily: DailyResult | null,
  modelUsage: ModelUsageResult | null,
  recentEvidence: Set<string> | null,
  historicalEvidence: Set<string> | null,
  ttft: Map<string, TtftEntry> | null,
  observedAt: string,
};

const DASHBOARD_CACHE_TTL_MS = 45_000;
let dashboardCaches = new WeakMap<object, { expiresAt: number, inFlight: Promise<DashboardStats> | null, value: DashboardStats | null }>();
let missingBindingCache: { expiresAt: number, inFlight: Promise<DashboardStats> | null, value: DashboardStats | null } = { expiresAt: 0, inFlight: null, value: null };
type CacheEntry = { expiresAt: number, inFlight: Promise<DashboardStats> | null, value: DashboardStats | null };
function newDashboardCacheEntry(): CacheEntry { return { expiresAt: 0, inFlight: null, value: null }; }
function dashboardCacheFor(env: Record<string, unknown> | null | undefined): CacheEntry {
  const d1 = env?.TOKEN_STATS_DB;
  if (!d1 || (typeof d1 !== 'object' && typeof d1 !== 'function') || typeof (d1 as { prepare?: unknown }).prepare !== 'function') return missingBindingCache;
  let entry = dashboardCaches.get(d1 as object);
  if (!entry) {
    entry = newDashboardCacheEntry();
    dashboardCaches.set(d1 as object, entry);
  }
  return entry;
}

export async function getCachedDashboardStats(env: Record<string, unknown>, now: number): Promise<DashboardStats> {
  const cache = dashboardCacheFor(env);
  const nowMs = typeof now === 'number' ? now : Date.now();
  if (cache.inFlight && cache.expiresAt > nowMs) return cache.inFlight;
  if (cache.value && cache.expiresAt > nowMs) return cache.value;
  cache.expiresAt = nowMs + DASHBOARD_CACHE_TTL_MS;
  const task = loadDashboardStats(env, now);
  const inFlight = task.finally(() => { if (cache.inFlight === inFlight) cache.inFlight = null; });
  cache.inFlight = inFlight;
  try {
    cache.value = await cache.inFlight;
    return cache.value;
  } catch (e) {
    cache.expiresAt = 0;
    throw e;
  }
}

export function __resetDashboardCacheForTests(): void {
  dashboardCaches = new WeakMap();
  missingBindingCache = newDashboardCacheEntry();
}

async function loadDashboardStats(env: Record<string, unknown>, now: number): Promise<DashboardStats> {
  const gridStartUtc8 = utc8DayStartUtcMs(now);
  const dow = (new Date(isoDayUtc8(gridStartUtc8)).getUTCDay() + 6) % 7;
  const currentWeekStartUtc8 = gridStartUtc8 - dow * DAY_MS;
  const startIso = isoDayUtc8(currentWeekStartUtc8 - (HEATMAP_WEEKS - 1) * 7 * DAY_MS);
  const [summary, daily, modelUsage, recentEvidence, historicalEvidence, ttftQuery] = await Promise.all([
    loadUpstreamSummary(env, now),
    loadUpstreamDaily(env, startIso, now),
    loadUpstreamModels(env, 7, now),
    queryRecentModelEvidence(env, MODEL_STATUS_RECENT_WINDOW_MS, now),
    queryRecentModelEvidence(env, MODEL_STATUS_HISTORICAL_WINDOW_MS, now),
    queryAllModelsTtftPercentiles(env, MODEL_STATUS_RECENT_WINDOW_MS, now),
  ]);
  const ttft = ttftQuery?.available && ttftQuery.ttft instanceof Map ? ttftQuery.ttft : new Map<string, TtftEntry>();
  return { summary, daily, modelUsage, recentEvidence, historicalEvidence, ttft, observedAt: new Date(now).toISOString() };
}
