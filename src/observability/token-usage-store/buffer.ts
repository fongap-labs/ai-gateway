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
// Flush triggers: at least FLUSH_EVENT_THRESHOLD buffered events, or at least
// FLUSH_INTERVAL_MS since the last flush (checked lazily on each event, with an
// idle timer as a backstop). flushUsageBuffer() forces a flush, and read paths
// and scheduled maintenance call it first.
//
// Best effort, like the isolate-local /metrics counters. Increments that are
// still buffered are lost if the isolate is recycled before they flush. A failed
// batch is atomic in D1, so its increments are merged back into the buffer and
// retried at the next flush rather than discarded.

import type { GatewayEnv } from '../../types/runtime.ts';
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
// window loses nothing but the increments of a recycled isolate.
const FLUSH_EVENT_THRESHOLD = 500;
const FLUSH_INTERVAL_MS = 30_000;

export type UsageEvent = {
  /** Event time in epoch milliseconds; selects the hour row. */
  now: number;
  model: string | null;
  usage: UsagePayload;
  /** Time to first token, delivered responses only. */
  ttftMs?: number | null;
};

type UsageEntry = {
  kind: UsageKind;
  hour: string;
  model: string | null;
  payload: UsagePayload;
  successTtftCount: number;
  ttftBuckets: number[];
  updatedAt: number;
  events: number;
};

// Pending increments for one D1 binding. Keyed by the binding object, so events
// recorded against one database are never written to another.
type PendingBatch = {
  entries: Map<string, UsageEntry>;
  events: number;
};

const pendingByDatabase: Map<UsageDatabase, PendingBatch> = new Map();
let bufferedEvents = 0;
let lastFlushAt = 0;
// After a failed flush, event-driven flushes wait FLUSH_INTERVAL_MS. Without this,
// a D1 outage would retry the whole buffer on every event.
let lastFailureAt = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function entryKey(kind: UsageKind, hour: string, model: string | null): string {
  return `${kind}\u0000${hour}\u0000${model ?? ''}`;
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
  const key = entryKey(entry.kind, entry.hour, entry.model);
  const current = into.get(key);
  if (!current) {
    into.set(key, { ...entry, payload: { ...entry.payload }, ttftBuckets: [...entry.ttftBuckets] });
    return;
  }
  addPayload(current.payload, entry.payload);
  current.successTtftCount += entry.successTtftCount;
  current.ttftBuckets.forEach((count, index) => {
    current.ttftBuckets[index] = count + (entry.ttftBuckets[index] ?? 0);
  });
  current.updatedAt = Math.max(current.updatedAt, entry.updatedAt);
  current.events += entry.events;
}

function persistFailure(cause: unknown): Error & { scope: string } {
  const rawMessage = (cause as { message?: unknown } | null | undefined)?.message || String(cause || 'D1 persistence failure');
  const error = new Error(String(rawMessage), { cause }) as Error & { scope: string };
  error.name = 'TokenStatsPersistError';
  error.scope = 'global';
  return error;
}

function clearFlushTimer(): void {
  if (flushTimer === null) return;
  clearTimeout(flushTimer);
  flushTimer = null;
}

function armFlushTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushUsageBuffer().catch((error) => {
      console.error('token-stats buffered flush failed:', (error as { message?: unknown } | null | undefined)?.message || error);
    });
  }, FLUSH_INTERVAL_MS);
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
  mergeEntry(batch.entries, {
    kind,
    hour,
    model,
    payload: { ...event.usage },
    successTtftCount,
    ttftBuckets,
    updatedAt: event.now,
    events: 1,
  });
  batch.events += 1;
  bufferedEvents += 1;

  const now = Date.now();
  const isRetryWindowOpen = now - lastFailureAt >= FLUSH_INTERVAL_MS;
  const isFlushDue = (bufferedEvents >= FLUSH_EVENT_THRESHOLD && isRetryWindowOpen) || now - lastFlushAt >= FLUSH_INTERVAL_MS;
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
    let total = hourTotals.get(totalKey);
    if (!total) {
      total = { kind: entry.kind, hour: entry.hour, payload: emptyPayload(), updatedAt: 0 };
      hourTotals.set(totalKey, total);
    }
    addPayload(total.payload, entry.payload);
    total.updatedAt = Math.max(total.updatedAt, entry.updatedAt);
    if (entry.model !== null) {
      statements.push(buildModelStatement(database, entry.kind, entry.hour, entry.model, entry.payload, entry.successTtftCount, entry.ttftBuckets));
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
  bufferedEvents -= batch.events;
  try {
    await database.batch(buildFlushStatements(database, batch.entries.values()));
  } catch (cause) {
    const current = pendingFor(database);
    for (const entry of batch.entries.values()) mergeEntry(current.entries, entry);
    current.events += batch.events;
    bufferedEvents += batch.events;
    lastFailureAt = Date.now();
    throw persistFailure(cause);
  }
}

/**
 * Writes every buffered increment, one D1 batch per database binding. If a batch
 * fails, the other bindings are still written, and the first failure is rethrown
 * after all of them have run.
 */
export async function flushUsageBuffer(): Promise<void> {
  clearFlushTimer();
  lastFlushAt = Date.now();
  let failure: { error: unknown } | null = null;
  for (const [database, batch] of [...pendingByDatabase.entries()]) {
    try {
      await flushDatabase(database, batch);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/**
 * Read paths call this first, so dashboard, model-status and /health numbers include
 * the increments this isolate has counted but not yet written. A failed flush is
 * logged, and the read continues with the stored rows.
 */
export async function flushBeforeRead(): Promise<void> {
  await flushUsageBuffer().catch((error) => {
    console.error('token-stats flush before read failed:', (error as { message?: unknown } | null | undefined)?.message || error);
  });
}

export function __resetUsageBufferForTests(): void {
  clearFlushTimer();
  pendingByDatabase.clear();
  bufferedEvents = 0;
  lastFlushAt = 0;
  lastFailureAt = 0;
}
