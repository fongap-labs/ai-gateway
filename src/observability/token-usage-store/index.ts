// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Public re-export surface for the token-usage store.

export { aggregateDailyToWeekly, aggregateHourlyToDaily } from './aggregation.ts';
export {
  DISPLAY_TIMEZONE_OFFSET_MS,
  isoDayUtc8,
  normalizeHour,
  normalizeModelKey,
  TTFT_BUCKET_BOUNDARIES_MS,
  tokenStatsD1,
  ttftBucketIndex,
  utc8DayStartUtcMs,
} from './keys.ts';

// Delivered-response queries remain the source for Public Model Status / TTFT.
export {
  MODEL_STATUS_HISTORICAL_WINDOW_MS,
  MODEL_STATUS_RECENT_WINDOW_MS,
  queryAllModelsTtftPercentiles,
  queryModelUsageCoverage,
  queryRecentModelEvidence,
  queryTokenDailySeries,
  queryTokenModelUsage,
  queryTokenSummary,
} from './queries.ts';
export {
  cleanupModelStats,
  cleanupUsageRetention,
  maintainUsageStats,
} from './retention.ts';
// Dashboard consumption queries: physical upstream attempts, including failed
// fallback/retry/hedge work when the upstream reported usage.
export {
  loadUpstreamDaily,
  loadUpstreamModels,
  loadUpstreamSummary,
} from './upstream-queries.ts';
export { persistTokenUsage, persistUpstreamAttemptUsage, tokenUsagePayload } from './writer.ts';
