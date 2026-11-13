// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Isolate-local write buffer for token-usage D1 upserts.
//
// Every physical upstream attempt used to issue its own upserts into the hot
// hour row. Under high request rates that queues D1 writes and spends the
// per-row write quota quickly. The buffer instead merges events by
// (kind, hour, model) and writes the merged increments in one d1.batch() call
// per database binding.
//
// The first delivered event per database and isolate is flushed promptly so a
// short-lived isolate can contribute success evidence. Subsequent flushes are
// rate-limited and triggered by a later event or explicit maintenance flush.
//
// Best effort, like the isolate-local /metrics counters. Increments that are
// still buffered are lost if the isolate is recycled before they flush. A failed
// batch is atomic in D1, so its increments are merged back into the buffer and
// retried at the next flush rather than discarded.

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

// Workers Free allows 100,000 D1 row writes a day and every flush upserts a few
// rows per table, so flushing every couple of seconds under steady traffic spends
// the allowance on bookkeeping. Events merge by (kind, hour, model), so a longer
// window reduces repeated writes but pending increments can be lost if the isolate
// is recycled before a later event or explicit flush submits them.
const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_EVENT_THRESHOLD = 500;

export type UsageEvent = {
  /** Event time in epoch milliseconds; selects the hour row. */
  now: number;
  model: string | null;
  usage: UsagePayload;
  /** Time to first token, delivered responses only. */
  ttftMs?: number | null;
  /** Persist global aggregates independently from optional per-model samples. */
  exactGlobal?: boolean;
  /** Include sampled per-model token and physical-attempt details. */
  includeModel?: boolean;
};

type UsageEntry = {
  kind: UsageKind;
  hour: string;
  model: string | null;
  payload: UsagePayload;
  // The delivered model row always contains success evidence. Its upstream
  // counters remain sampled independently from that evidence.
  modelUpstream: UsagePayload | null;
  successTtftCount: number;
  ttftBuckets: number[];
  updatedAt: number;
  events: number;
  countTowardGlobal: boolean;
};

// Pending increments for one D1 binding. Keyed by the binding object, so events
// recorded against one database are never written to another.
type PendingBatch = {
  entries: Map<string, UsageEntry>;
  events: number;
};

const pendingByDatabase: Map<UsageDatabase, PendingBatch> = new Map();
let databasesWithInitialFlush = new WeakSet<UsageDatabase>();
let bufferedEvents = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;
let lastFlushAt = 0;
// After a failed flush, event-driven flushes wait FLUSH_INTERVAL_MS. Without this,
// a D1 outage would retry the whole buffer on every event.
let lastFailureAt = 0;
// Counters track actual D1 batch results returned by the runtime, not estimates
// of the account-wide Cloudflare allowance. They reset with the isolate.
const writeStats = {
  batchAttempts: 0,
  batchSuccesses: 0,
  batchFailures: 0,
  committedStatements: 0,
  reportedRowsWritten: 0,
  statementsWithoutRowMetadata: 0,
};

/** Read-only isolate snapshot: does not read or write D1. */
export function snapshotUsageBuffer() {
  let pendingEntries = 0;
  for (const batch of pendingByDatabase.values()) pendingEntries += batch.entries.size;
  return {
    pendingEvents: bufferedEvents,
    pendingDatabases: pendingByDatabase.size,
    pendingEntries,
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
    batch = { entries: new Map(), events: 0 };
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
  // This detached timer is opportunistic: Workers may suspend or recycle an
  // isolate when the request ends. It is not protected by ctx.waitUntil(), so
  // its firing must never be treated as a durability guarantee or used to
  // justify lower D1 usage estimates.
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushUsageBuffer().catch((error) => {
      console.error('token-stats buffered flush failed:', (error as Error)?.message || error);
    });
  }, FLUSH_INTERVAL_MS);
  // Node-based central tests must not remain alive solely for a statistics timer.
  // Workers return a numeric timeout handle and ignore this optional method.
  (flushTimer as unknown as { unref?: () => void }).unref?.();
}

function persistFailure(cause: unknown): Error & { scope: string } {
  const rawMessage = (cause as { message?: unknown } | null | undefined)?.message || String(cause || 'D1 persistence failure');
  const error = new Error(String(rawMessage), { cause }) as Error & { scope: string };
  error.name = 'TokenStatsPersistError';
  error.scope = 'global';
  return error;
}

/**
 * Buffers one usage event. Resolves immediately while buffering. When this event
 * triggers a flush, the returned promise settles with that flush, so a caller that
 * passes it to waitUntil keeps the isolate alive until the write completes.
 */
export function bufferPersist(env: GatewayEnv, kind: UsageKind, event: UsageEvent): Promise<void> {
  const database = tokenStatsD1(env);
  if (!database) return Promise.resolve();
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
  // Cold isolates must persist their first attempt, including failure-only traffic.
  if (!databasesWithInitialFlush.has(database) && isRetryWindowOpen) {
    databasesWithInitialFlush.add(database);
    return flushUsageBuffer();
  }
  if (isFlushDue && isRetryWindowOpen) return flushUsageBuffer();
  armFlushTimer();
  return Promise.resolve();
}

function buildFlushStatements(database: UsageDatabase, taken: Iterable<UsageEntry>): UsageStatement[] {
  // Hour totals are summed across models, so each (kind, hour) gets one global
  // upsert per table. The model rows keep their own upsert.
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

// Writes one database's pending batch in a single D1 batch. On failure the
// increments are merged back into that database's pending batch and the error is
// rethrown.
async function flushDatabase(database: UsageDatabase, batch: PendingBatch): Promise<void> {
  pendingByDatabase.delete(database);
  try {
    // Preparation can fail too (for example a D1 binding error). Keep it
    // inside the failure boundary so queued increments are always restored.
    const statements = buildFlushStatements(database, batch.entries.values());
    writeStats.batchAttempts++;
    const results = await database.batch(statements);
    // D1Result.success is part of the batch contract. An adapter may resolve
    // with an explicit unsuccessful statement instead of throwing; never count
    // such a batch as committed or discard its pending increments.
    if (Array.isArray(results) && results.some((result) => result?.success === false)) {
      throw new Error('D1 batch returned an unsuccessful statement');
    }
    writeStats.batchSuccesses++;
    writeStats.committedStatements += statements.length;
    let reportedStatements = 0;
    // The D1 runtime may omit metadata in a test double or an older adapter.
    // Count only rows explicitly reported by D1, never guess the missing rows.
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
    current.events += batch.events;
    lastFailureAt = Date.now();
    throw persistFailure(cause);
  }
}

/**
 * Writes every buffered increment, one D1 batch per database binding. If a batch
 * fails, the other bindings are still written, and the first failure is rethrown
 * after all of them have run.
 */
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

// Read paths only nudge a flush after its normal interval, so dashboard
// traffic cannot turn every buffered write into a new D1 transaction.
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
  lastFlushAt = 0;
  lastFailureAt = 0;
  writeStats.batchAttempts = 0;
  writeStats.batchSuccesses = 0;
  writeStats.batchFailures = 0;
  writeStats.committedStatements = 0;
  writeStats.reportedRowsWritten = 0;
  writeStats.statementsWithoutRowMetadata = 0;
}
