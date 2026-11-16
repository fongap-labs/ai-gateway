const MAX_BUCKETS = 512;
const MAX_DIMENSION_LENGTH = 80;

const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;
const HOURS_24 = 24;
const DAYS_7 = 7;

export type NormalizedTokenUsage = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  effectiveInput: number;
  total: number;
};

export type TokenUsageBucket = {
  model: string;
  tier: string;
  provider: string;
  nodeId: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  effectiveInput: number;
  total: number;
  reports: number;
  missing: number;
};

export type RollingWindowBucket = { total: number; reports: number };

export const tokenStats: {
  startedAt: number;
  totals: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
    effectiveInput: number;
    total: number;
    reports: number;
    missing: number;
  };
  buckets: Map<string, TokenUsageBucket>;
  hourBuckets: Map<number, RollingWindowBucket>;
  dayBuckets: Map<number, RollingWindowBucket>;
} = {
  startedAt: 0,
  totals: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, effectiveInput: 0, total: 0, reports: 0, missing: 0 },
  buckets: new Map(),
  hourBuckets: new Map(),
  dayBuckets: new Map(),
};

export function startTokenStats(now: number = Date.now()): void {
  if (tokenStats.startedAt <= 0 && Number.isFinite(now) && now > 0) tokenStats.startedAt = now;
}

function validTokenCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

export function mergeReportedUsage(previous: unknown, next: unknown): unknown {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return previous;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return next;
  const prev = previous as Record<string, unknown>;
  const nxt = next as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...prev };
  for (const key of Object.keys(nxt)) {
    const val = nxt[key];
    const valid = validTokenCount(val);
    if (valid !== null) {
      merged[key] = valid;
    } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      merged[key] = mergeReportedUsage(prev[key], val);
    }
  }
  return merged;
}

type UsageReport = {
  usage: NormalizedTokenUsage;
  hasCacheRead: boolean;
  observedCacheInput: number;
  observedCacheRead: number;
};

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(obj, key);
}

function nestedCachedToken(container: unknown): { provided: boolean; raw: unknown } {
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    return { provided: false, raw: undefined };
  }
  const details = container as Record<string, unknown>;
  return hasOwn(details, 'cached_tokens') ? { provided: true, raw: details.cached_tokens } : { provided: false, raw: undefined };
}

export function normalizeUsageReport(usage: unknown): UsageReport | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const report = usage as Record<string, unknown>;

  const inputRaw = report.input_tokens ?? report.prompt_tokens;
  const outputRaw = report.output_tokens ?? report.completion_tokens;
  const cacheCreationRaw = report.cache_creation_input_tokens;

  const hasAnthropicRead = hasOwn(report, 'cache_read_input_tokens');
  const anthropicReadRaw = report.cache_read_input_tokens;

  const promptDetails = nestedCachedToken(report.prompt_tokens_details);
  const inputDetails = nestedCachedToken(report.input_tokens_details);
  const hasCacheHit = hasOwn(report, 'prompt_cache_hit_tokens');
  const cacheHitRaw = report.prompt_cache_hit_tokens;

  if (inputRaw !== undefined && validTokenCount(inputRaw) === null) return null;
  if (outputRaw !== undefined && validTokenCount(outputRaw) === null) return null;
  if (cacheCreationRaw !== undefined && validTokenCount(cacheCreationRaw) === null) return null;
  if (hasAnthropicRead && validTokenCount(anthropicReadRaw) === null) return null;
  if (promptDetails.provided && validTokenCount(promptDetails.raw) === null) return null;
  if (inputDetails.provided && validTokenCount(inputDetails.raw) === null) return null;
  if (hasCacheHit && validTokenCount(cacheHitRaw) === null) return null;

  const input = validTokenCount(inputRaw) ?? 0;
  const output = validTokenCount(outputRaw) ?? 0;
  const cacheCreation = validTokenCount(cacheCreationRaw) ?? 0;

  let cacheRead = 0;
  let hasCacheRead = false;
  let isCacheSubset = false;

  if (hasAnthropicRead) {
    cacheRead = validTokenCount(anthropicReadRaw) ?? 0;
    hasCacheRead = true;
  } else {
    const candidates = report.prompt_tokens !== undefined ? [promptDetails, inputDetails] : [inputDetails, promptDetails];
    const detail = candidates.find((candidate) => candidate.provided);
    if (detail) {
      cacheRead = validTokenCount(detail.raw) ?? 0;
      hasCacheRead = true;
      isCacheSubset = true;
    } else if (hasCacheHit) {
      cacheRead = validTokenCount(cacheHitRaw) ?? 0;
      hasCacheRead = true;
      isCacheSubset = true;
    }
  }

  if (isCacheSubset && inputRaw !== undefined && cacheRead > input) return null;

  if (inputRaw === undefined && outputRaw === undefined && cacheCreationRaw === undefined && !hasCacheRead && report.total_tokens === undefined) {
    return null;
  }

  const effectiveInput = isCacheSubset
    ? inputRaw === undefined
      ? cacheRead + cacheCreation
      : input + cacheCreation
    : input + cacheCreation + cacheRead;

  let total: number;
  if (report.total_tokens !== undefined) {
    const reportedTotal = validTokenCount(report.total_tokens);
    if (reportedTotal === null) return null;
    total = reportedTotal;
  } else {
    total = effectiveInput + output;
  }

  const normalized = { input, output, cacheCreation, cacheRead, effectiveInput, total };
  const hasCacheSample = hasCacheRead && inputRaw !== undefined;
  return {
    usage: normalized,
    hasCacheRead,
    observedCacheInput: hasCacheSample ? effectiveInput : 0,
    observedCacheRead: hasCacheSample ? cacheRead : 0,
  };
}

export function normalizeTokenUsage(usage: unknown): NormalizedTokenUsage | null {
  return normalizeUsageReport(usage)?.usage ?? null;
}

function sanitizeDimension(value: unknown): string {
  const raw = String(value ?? '');
  const cleaned = raw.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, MAX_DIMENSION_LENGTH);
  return cleaned || 'unknown';
}

function bumpWindow(map: Map<number, RollingWindowBucket>, now: number, unitMs: number, keep: number, total: number): void {
  const start = Math.floor(now / unitMs) * unitMs;
  const cutoff = start - (keep - 1) * unitMs;
  for (const ts of map.keys()) {
    if (ts < cutoff) map.delete(ts);
  }
  let b = map.get(start);
  if (!b) {
    b = { total: 0, reports: 0 };
    map.set(start, b);
  }
  b.total += total;
  b.reports += 1;
}

function sumWindow(map: Map<number, RollingWindowBucket>): { total: number; reports: number } {
  let total = 0;
  let reports = 0;
  for (const b of map.values()) {
    total += b.total;
    reports += b.reports;
  }
  return { total, reports };
}

export function recordTokenUsage({
  model,
  tier,
  provider,
  nodeId,
  usage,
  now = Date.now(),
}: {
  model: unknown;
  tier: unknown;
  provider: unknown;
  nodeId: unknown;
  usage: unknown;
  now?: number;
}): void {
  startTokenStats(now);
  const dims = {
    model: sanitizeDimension(model),
    tier: sanitizeDimension(tier),
    provider: sanitizeDimension(provider),
    nodeId: sanitizeDimension(nodeId),
  };
  const key = `${dims.model}|${dims.tier}|${dims.provider}|${dims.nodeId}`;
  const bucket = (): TokenUsageBucket | null => {
    let b = tokenStats.buckets.get(key);
    if (!b) {
      if (tokenStats.buckets.size >= MAX_BUCKETS) return null;
      b = { ...dims, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, effectiveInput: 0, total: 0, reports: 0, missing: 0 };
      tokenStats.buckets.set(key, b);
    }
    return b;
  };
  const normalized = normalizeTokenUsage(usage);
  if (!normalized) {
    tokenStats.totals.missing += 1;
    const b = bucket();
    if (b) b.missing += 1;
    return;
  }
  tokenStats.totals.reports += 1;
  tokenStats.totals.input += normalized.input;
  tokenStats.totals.output += normalized.output;
  tokenStats.totals.cacheCreation += normalized.cacheCreation;
  tokenStats.totals.cacheRead += normalized.cacheRead;
  tokenStats.totals.effectiveInput += normalized.effectiveInput;
  tokenStats.totals.total += normalized.total;
  bumpWindow(tokenStats.hourBuckets, now, HOUR_MS, HOURS_24, normalized.total);
  bumpWindow(tokenStats.dayBuckets, now, DAY_MS, DAYS_7, normalized.total);
  const b = bucket();
  if (!b) return;
  b.reports += 1;
  b.input += normalized.input;
  b.output += normalized.output;
  b.cacheCreation += normalized.cacheCreation;
  b.cacheRead += normalized.cacheRead;
  b.effectiveInput += normalized.effectiveInput;
  b.total += normalized.total;
}

type DimensionName = 'model' | 'provider' | 'tier' | 'nodeId';
type DimensionRow = { name: string; input: number; output: number; total: number; reports: number; missing: number };

function aggregateBy(dimension: DimensionName): DimensionRow[] {
  const rows = new Map<string, DimensionRow>();
  for (const bucket of tokenStats.buckets.values()) {
    const name = bucket[dimension];
    let row = rows.get(name);
    if (!row) {
      row = { name, input: 0, output: 0, total: 0, reports: 0, missing: 0 };
      rows.set(name, row);
    }
    row.input += bucket.input;
    row.output += bucket.output;
    row.total += bucket.total;
    row.reports += bucket.reports;
    row.missing += bucket.missing;
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

function usageCoverage(): number | null {
  const denominator = tokenStats.totals.reports + tokenStats.totals.missing;
  return denominator === 0 ? null : tokenStats.totals.reports / denominator;
}

export function summarizeTokenStats() {
  startTokenStats();
  return {
    startedAt: tokenStats.startedAt,
    totals: { ...tokenStats.totals },
    usageCoverage: usageCoverage(),
    windows: {
      h24: sumWindow(tokenStats.hourBuckets),
      d7: sumWindow(tokenStats.dayBuckets),
    },
    byModel: aggregateBy('model'),
    byProvider: aggregateBy('provider'),
    byTier: aggregateBy('tier'),
    byNode: aggregateBy('nodeId'),
  };
}

export function tokenMetricSeries(): TokenUsageBucket[] {
  return [...tokenStats.buckets.values()];
}

export function __resetTokenStatsForTests(): void {
  tokenStats.startedAt = Date.now();
  tokenStats.totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, effectiveInput: 0, total: 0, reports: 0, missing: 0 };
  tokenStats.buckets = new Map();
  tokenStats.hourBuckets = new Map();
  tokenStats.dayBuckets = new Map();
}
