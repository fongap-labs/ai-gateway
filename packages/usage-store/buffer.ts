import type { GatewayEnv } from '../contracts/runtime.ts';
import { normalizeHour, normalizeModelKey, TTFT_BUCKET_COUNT, tokenStatsD1, ttftBucketIndex } from './keys.ts';
import {
  buildGlobalStatements,
  buildModelStatement,
  type UsageDatabase,
  type UsageKind,
  type UsagePayload,
  type UsageStatement,
} from './statements.ts';

const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_EVENT_THRESHOLD = 500;
const MAX_BUFFERED_EVENTS = 1_000;

export type UsageEvent = {
  now: number;
  model: string | null;
  usage: UsagePayload;
  ttftMs?: number | null;
  exactGlobal?: boolean;
  includeModel?: boolean;
};

type UsageEntry = {
  kind: UsageKind;
  hour: string;
  model: string | null;
  payload: UsagePayload;
  modelUpstream: UsagePayload | null;
  successTtftCount: number;
  ttftBuckets: number[];
  updatedAt: number;
  events: number;
  countTowardGlobal: boolean;
};

type PendingBatch = {
  entries: Map<string, UsageEntry>;
  events: number;
  oldestQueuedAt: number;
};

const pendingByDatabase: Map<UsageDatabase, PendingBatch> = new Map();
let databasesWithInitialFlush = new WeakSet<UsageDatabase>();
let bufferedEvents = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;
let inFlightOldestQueuedAt: number | null = null;
let lastFlushAt = 0;
let lastFailureAt = 0;
const writeStats = {
  batchAttempts: 0,
  batchSuccesses: 0,
  batchFailures: 0,
  committedStatements: 0,
  reportedRowsWritten: 0,
  statementsWithoutRowMetadata: 0,
  droppedEvents: 0,
};

export function snapshotUsageBuffer(now: number = Date.now()) {
  let pendingEntries = 0;
  let oldestQueuedAt = inFlightOldestQueuedAt;
  for (const batch of pendingByDatabase.values()) {
    pendingEntries += batch.entries.size;
    oldestQueuedAt = oldestQueuedAt === null ? batch.oldestQueuedAt : Math.min(oldestQueuedAt, batch.oldestQueuedAt);
  }
  return {
    pendingEvents: bufferedEvents,
    pendingDatabases: pendingByDatabase.size,
    pendingEntries,
    oldestPendingAgeSeconds: bufferedEvents > 0 && oldestQueuedAt !== null ? Math.max(0, Math.floor((now - oldestQueuedAt) / 1_000)) : 0,
    flushing: flushInFlight !== null,
    ...writeStats,
  };
}

function entryKey(kind: UsageKind, hour: string, model: string | null, shouldCountTowardGlobal: boolean): string {
  return `${kind}\u0000${hour}\u0000${model ?? ''}\u0000${shouldCountTowardGlobal ? 'global' : 'detail'}`;
}

function pendingFor(database: UsageDatabase): PendingBatch {
  let batch = pendingByDatabase.get(database);
  if (!batch) {
    batch = { entries: new Map(), events: 0, oldestQueuedAt: Date.now() };
    pendingByDatabase.set(database, batch);
  }
  return batch;
}

function emptyPayload(): UsagePayload {
  return {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    effectiveInput: 0,
    observedCacheRead: 0,
    observedCacheInput: 0,
    cacheReadReports: 0,
    total: 0,
    requests: 0,
    reports: 0,
    missing: 0,
  };
}

function addPayload(target: UsagePayload, source: UsagePayload): void {
  for (const field of Object.keys(target) as Array<keyof UsagePayload>) target[field] += source[field];
}

function mergeEntry(into: Map<string, UsageEntry>, entry: UsageEntry): void {
  const key = entryKey(entry.kind, entry.hour, entry.model, entry.countTowardGlobal);
  const current = into.get(key);
  if (!current) {
    into.set(key, {
      ...entry,
      payload: { ...entry.payload },
      modelUpstream: entry.modelUpstream && { ...entry.modelUpstream },
      ttftBuckets: [...entry.ttftBuckets],
    });
    return;
  }
  addPayload(current.payload, entry.payload);
  if (current.modelUpstream && entry.modelUpstream) addPayload(current.modelUpstream, entry.modelUpstream);
  current.successTtftCount += entry.successTtftCount;
  current.ttftBuckets.forEach((count, index) => {
    current.ttftBuckets[index] = count + (entry.ttftBuckets[index] ?? 0);
  });
  current.updatedAt = Math.max(current.updatedAt, entry.updatedAt);
  current.events += entry.events;
}

function clearFlushTimer(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
}

function armFlushTimer(): void {
  if (flushTimer !== null || pendingByDatabase.size === 0) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushUsageBuffer().catch((error) => {
      console.error('token-stats buffered flush failed:', (error as Error)?.message || error);
    });
  }, FLUSH_INTERVAL_MS);
  (flushTimer as unknown as { unref?: () => void }).unref?.();
}

function persistFailure(cause: unknown): Error & { scope: string } {
  const rawMessage = (cause as { message?: unknown } | null | undefined)?.message || String(cause || 'D1 persistence failure');
  const error = new Error(String(rawMessage), { cause }) as Error & { scope: string };
  error.name = 'TokenStatsPersistError';
  error.scope = 'global';
  return error;
}

export function bufferPersist(env: GatewayEnv, kind: UsageKind, event: UsageEvent): Promise<void> {
  const database = tokenStatsD1(env);
  if (!database) return Promise.resolve();
  if (bufferedEvents >= MAX_BUFFERED_EVENTS) {
    writeStats.droppedEvents++;
    return Promise.resolve();
  }
  const hour = normalizeHour(event.now);
  const model = typeof event.model === 'string' && event.model.length > 0 ? normalizeModelKey(event.model) : null;
  const ttftBuckets = Array.from({ length: TTFT_BUCKET_COUNT }, () => 0);
  let successTtftCount = 0;
  if (kind === 'delivered' && event.ttftMs != null) {
    const bucket = ttftBucketIndex(event.ttftMs);
    if (bucket >= 0) {
      ttftBuckets[bucket] = 1;
      successTtftCount = 1;
    }
  }
  const batch = pendingFor(database);
  const entry = (
    entryModel: string | null,
    payload: UsagePayload,
    shouldCountTowardGlobal: boolean,
    modelUpstream: UsagePayload | null,
  ): UsageEntry => ({
    kind,
    hour,
    model: entryModel,
    payload: { ...payload },
    modelUpstream: modelUpstream && { ...modelUpstream },
    successTtftCount: entryModel === null ? 0 : successTtftCount,
    ttftBuckets: entryModel === null ? Array.from({ length: TTFT_BUCKET_COUNT }, () => 0) : [...ttftBuckets],
    updatedAt: event.now,
    events: 1,
    countTowardGlobal: shouldCountTowardGlobal,
  });
  if (event.exactGlobal) {
    mergeEntry(batch.entries, entry(null, event.usage, true, null));
    if (model !== null && (kind === 'delivered' || event.includeModel)) {
      const sampled = event.includeModel === true;
      const payload = sampled
        ? event.usage
        : { ...emptyPayload(), requests: event.usage.requests, reports: event.usage.reports, missing: event.usage.missing };
      mergeEntry(batch.entries, entry(model, payload, false, kind === 'delivered' ? (sampled ? event.usage : emptyPayload()) : null));
    }
  } else {
    mergeEntry(batch.entries, entry(model, event.usage, true, kind === 'delivered' && model !== null ? event.usage : null));
  }
  batch.events += 1;
  bufferedEvents += 1;

  const now = Date.now();
  if (lastFlushAt === 0) lastFlushAt = now;
  const isRetryWindowOpen = now - lastFailureAt >= FLUSH_INTERVAL_MS;
  const isFlushDue = bufferedEvents >= FLUSH_EVENT_THRESHOLD || now - lastFlushAt >= FLUSH_INTERVAL_MS;
  if (!databasesWithInitialFlush.has(database) && isRetryWindowOpen) {
    databasesWithInitialFlush.add(database);
    return flushUsageBuffer();
  }
  if (isFlushDue && isRetryWindowOpen) return flushUsageBuffer();
  armFlushTimer();
  return Promise.resolve();
}

function buildFlushStatements(database: UsageDatabase, taken: Iterable<UsageEntry>): UsageStatement[] {
  const hourTotals = new Map<string, { kind: UsageKind; hour: string; payload: UsagePayload; updatedAt: number }>();
  const statements: UsageStatement[] = [];
  for (const entry of taken) {
    const totalKey = `${entry.kind}\u0000${entry.hour}`;
    if (entry.countTowardGlobal) {
      let total = hourTotals.get(totalKey);
      if (!total) {
        total = { kind: entry.kind, hour: entry.hour, payload: emptyPayload(), updatedAt: 0 };
        hourTotals.set(totalKey, total);
      }
      addPayload(total.payload, entry.payload);
      total.updatedAt = Math.max(total.updatedAt, entry.updatedAt);
    }
    if (entry.model !== null) {
      statements.push(
        buildModelStatement(
          database,
          entry.kind,
          entry.hour,
          entry.model,
          entry.payload,
          entry.successTtftCount,
          entry.ttftBuckets,
          entry.modelUpstream,
        ),
      );
    }
  }
  for (const total of hourTotals.values()) {
    statements.push(...buildGlobalStatements(database, total.kind, total.hour, total.payload, total.updatedAt));
  }
  return statements;
}

async function flushDatabase(database: UsageDatabase, batch: PendingBatch): Promise<void> {
  pendingByDatabase.delete(database);
  inFlightOldestQueuedAt = batch.oldestQueuedAt;
  try {
    const statements = buildFlushStatements(database, batch.entries.values());
    writeStats.batchAttempts++;
    const results = await database.batch(statements);
    if (Array.isArray(results) && results.some((result) => result?.success === false)) {
      throw new Error('D1 batch returned an unsuccessful statement');
    }
    writeStats.batchSuccesses++;
    writeStats.committedStatements += statements.length;
    let reportedStatements = 0;
    if (Array.isArray(results)) {
      for (const result of results) {
        const rows = result?.meta?.rows_written;
        if (typeof rows === 'number' && Number.isSafeInteger(rows) && rows >= 0) {
          reportedStatements++;
          writeStats.reportedRowsWritten += rows;
        }
      }
    }
    writeStats.statementsWithoutRowMetadata += Math.max(0, statements.length - reportedStatements);
    bufferedEvents = Math.max(0, bufferedEvents - batch.events);
  } catch (cause) {
    writeStats.batchFailures++;
    const current = pendingFor(database);
    for (const entry of batch.entries.values()) mergeEntry(current.entries, entry);
    current.oldestQueuedAt = Math.min(current.oldestQueuedAt, batch.oldestQueuedAt);
    current.events += batch.events;
    lastFailureAt = Date.now();
    throw persistFailure(cause);
  } finally {
    inFlightOldestQueuedAt = null;
  }
}

export function flushUsageBuffer(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  clearFlushTimer();
  lastFlushAt = Date.now();
  const work = async (): Promise<void> => {
    let failure: { error: unknown } | null = null;
    for (const [database, batch] of [...pendingByDatabase.entries()]) {
      try {
        await flushDatabase(database, batch);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  };
  flushInFlight = work().finally(() => {
    flushInFlight = null;
    if (pendingByDatabase.size > 0) armFlushTimer();
  });
  return flushInFlight;
}

export async function flushBeforeRead(): Promise<void> {
  if (pendingByDatabase.size === 0 && !flushInFlight) return;
  if (!flushInFlight && Date.now() - lastFlushAt < FLUSH_INTERVAL_MS) return;
  await flushUsageBuffer().catch((error) => {
    console.error('token-stats flush before read failed:', (error as Error)?.message || error);
  });
}

export function __resetUsageBufferForTests(): void {
  clearFlushTimer();
  pendingByDatabase.clear();
  databasesWithInitialFlush = new WeakSet();
  bufferedEvents = 0;
  flushInFlight = null;
  inFlightOldestQueuedAt = null;
  lastFlushAt = 0;
  lastFailureAt = 0;
  writeStats.batchAttempts = 0;
  writeStats.batchSuccesses = 0;
  writeStats.batchFailures = 0;
  writeStats.committedStatements = 0;
  writeStats.reportedRowsWritten = 0;
  writeStats.statementsWithoutRowMetadata = 0;
  writeStats.droppedEvents = 0;
}
