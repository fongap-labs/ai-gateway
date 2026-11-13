#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Regression: independent D1 reads overlap after buffered writes flush, with
// identical cumulative/hourly results and the old-schema fallback retained.
import assert from 'node:assert/strict';
import { __resetUsageBufferForTests, bufferPersist, flushUsageBuffer, snapshotUsageBuffer } from '../packages/usage-store/buffer.ts';
import { metricsResponse } from '../src/observability/diagnostic-endpoints.ts';
import { loadUpstreamSummary } from '../src/observability/token-usage-store/upstream-queries.ts';

const now = Date.UTC(2026, 10, 12, 1, 0);
const currentTotals = {
  upstream_effective_input_tokens: 100,
  upstream_output_tokens: 20,
  upstream_cache_read_input_tokens: 10,
  upstream_cache_observed_read_tokens: 8,
  upstream_cache_observed_input_tokens: 100,
  upstream_cache_read_reports: 1,
  upstream_total_tokens: 120,
  upstream_attempts: 3,
  upstream_usage_reports: 2,
  upstream_usage_missing: 1,
  total_tokens: 60,
  requests: 2,
  updated_at: '2026-11-12T00:00:00Z',
};
const currentHourly = {
  today_total: 7,
  today_attempts: 1,
  h24_total: 40,
  h24_attempts: 2,
  h24_input: 30,
  h24_cache_read: 5,
  h24_cache_observed_read: 4,
  h24_cache_observed_input: 30,
  h24_cache_read_reports: 1,
  h24_output: 10,
  d7_total: 110,
  d7_attempts: 3,
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const totalsGate = deferred();
const hourlyGate = deferred();
const readCalls = [];
const gatedD1 = {
  prepare(sql) {
    const kind = sql.includes('FROM token_usage_totals') ? 'totals' : 'hourly';
    return {
      bind() {
        return this;
      },
      first() {
        readCalls.push(kind);
        return kind === 'totals' ? totalsGate.promise : hourlyGate.promise;
      },
    };
  },
};
__resetUsageBufferForTests();
const pending = loadUpstreamSummary({ TOKEN_STATS_DB: gatedD1 }, now);
for (let i = 0; i < 4; i++) await Promise.resolve();
assert.deepEqual(readCalls, ['totals', 'hourly'], 'both independent reads must start before either D1 result arrives');
let resolvedBeforeTotals = false;
void pending.then(() => {
  resolvedBeforeTotals = true;
});
hourlyGate.resolve(currentHourly);
for (let i = 0; i < 3; i++) await Promise.resolve();
assert.equal(resolvedBeforeTotals, false, 'summary must wait for cumulative and hourly results');
totalsGate.resolve(currentTotals);
const summary = await pending;
assert.equal(summary?.available, true);
assert.deepEqual(summary.today, { total: 7, requests: 1 });
assert.deepEqual(summary.d7, { total: 110, requests: 3 });
assert.equal(summary.h24.input, 26);
assert.equal(summary.h24.cacheRead, 4);
assert.equal(summary.h24.cacheHitRatio, 4 / 30);
assert.equal(summary.cumulative.total, 120);
assert.equal(summary.cumulative.deliveredTotal, 60);
assert.equal(summary.cumulative.deliveredRequests, 2);
assert.equal(summary.cumulative.input, 92);
assert.equal(summary.coverage, 2 / 3);

// Missing v0010 cache-observation columns must activate the same older-schema
// fallbacks independently for the totals and hourly tables.
const legacySql = [];
const legacyD1 = {
  prepare(sql) {
    const isTotals = sql.includes('FROM token_usage_totals');
    const modern = sql.includes('upstream_effective_input_tokens');
    return {
      bind() {
        return this;
      },
      async first() {
        legacySql.push({ isTotals, modern });
        if (modern) throw new Error('no such column: upstream_effective_input_tokens');
        if (isTotals) {
          return {
            upstream_input_tokens: 30,
            upstream_cache_creation_input_tokens: 3,
            upstream_cache_read_input_tokens: 7,
            upstream_total_tokens: 44,
            upstream_attempts: 2,
            upstream_usage_reports: 2,
            upstream_usage_missing: 0,
            upstream_output_tokens: 4,
          };
        }
        return {
          ...currentHourly,
          h24_input_raw: 11,
          h24_cache_creation: 2,
          h24_cache_read: 3,
        };
      },
    };
  },
};
const legacy = await loadUpstreamSummary({ TOKEN_STATS_DB: legacyD1 }, now);
assert.equal(legacy?.available, true);
assert.deepEqual(
  legacySql
    .filter((read) => read.modern)
    .map((read) => read.isTotals)
    .sort(),
  [false, true],
);
assert.equal(legacy.cumulative.input, 40);
assert.equal(legacy.h24.input, 16);
assert.equal(legacy.h24.cacheHitRatio, null);

const brokenD1 = {
  prepare(sql) {
    return {
      bind() {
        return this;
      },
      async first() {
        if (!sql.includes('FROM token_usage_totals')) throw new Error('hourly unavailable');
        return currentTotals;
      },
    };
  },
};
const broken = await loadUpstreamSummary({ TOKEN_STATS_DB: brokenD1 }, now);
assert.equal(broken?.available, false);
assert.match(broken.error, /loadUpstreamSummary: hourly unavailable/);
// Write observability must reflect D1-reported rows, not extrapolate quota.
// The first event is flushed promptly; subsequent events are buffered without
// D1 I/O until a normal explicit flush.
__resetUsageBufferForTests();
let writeCalls = 0;
let failNextBatch = false;
const writeD1 = {
  prepare() {
    return {
      bind() {
        return this;
      },
    };
  },
  async batch(statements) {
    writeCalls++;
    if (failNextBatch) {
      failNextBatch = false;
      throw new Error('temporary D1 outage');
    }
    return statements.map(() => ({ meta: { rows_written: 1 } }));
  },
};
const usagePayload = {
  input: 1,
  output: 2,
  cacheCreation: 0,
  cacheRead: 0,
  effectiveInput: 1,
  observedCacheRead: 0,
  observedCacheInput: 0,
  cacheReadReports: 0,
  total: 3,
  requests: 1,
  reports: 1,
  missing: 0,
};
const usageEvent = { now, model: 'Code-Ultra', usage: usagePayload, exactGlobal: true, includeModel: true };
await bufferPersist({ TOKEN_STATS_DB: writeD1 }, 'delivered', usageEvent);
const committed = snapshotUsageBuffer();
assert.equal(committed.batchAttempts, 1);
assert.equal(committed.batchSuccesses, 1);
assert.equal(committed.batchFailures, 0);
assert.ok(committed.reportedRowsWritten > 0);
assert.equal(committed.statementsWithoutRowMetadata, 0);
assert.equal(committed.pendingEvents, 0);
await bufferPersist({ TOKEN_STATS_DB: writeD1 }, 'delivered', usageEvent);
assert.equal(snapshotUsageBuffer().pendingEvents, 1);
assert.equal(writeCalls, 1, 'buffered events must not trigger an extra D1 write');
const beforeMetrics = await metricsResponse(new Request('https://gateway.example/metrics'), {}, 'usage-d1-test').text();
assert.match(beforeMetrics, /gateway_usage_d1_buffer_pending_events\{\} 1/);
assert.equal(writeCalls, 1, 'metrics must never query or flush D1');
failNextBatch = true;
await assert.rejects(flushUsageBuffer(), /temporary D1 outage/);
assert.equal(snapshotUsageBuffer().batchFailures, 1);
assert.equal(snapshotUsageBuffer().pendingEvents, 1, 'a failed batch must requeue its usage increments');
await flushUsageBuffer();
assert.equal(snapshotUsageBuffer().batchAttempts, 3);
assert.equal(snapshotUsageBuffer().batchSuccesses, 2);
assert.equal(snapshotUsageBuffer().pendingEvents, 0);
assert.equal(writeCalls, 3);
const finalMetrics = await metricsResponse(new Request('https://gateway.example/metrics'), {}, 'usage-d1-test').text();
assert.match(finalMetrics, /gateway_usage_d1_batches_failed_total\{\} 1/);
assert.match(finalMetrics, /gateway_usage_d1_buffer_pending_events\{\} 0/);
__resetUsageBufferForTests();
assert.equal(snapshotUsageBuffer().batchAttempts, 0, 'isolate test reset must clear D1 counters');

// Missing D1 row metadata must remain unknown, not become fabricated writes.
const noMetaD1 = {
  ...writeD1,
  async batch(statements) {
    return statements.map(() => ({ success: true }));
  },
};
await bufferPersist({ TOKEN_STATS_DB: noMetaD1 }, 'delivered', usageEvent);
assert.equal(snapshotUsageBuffer().reportedRowsWritten, 0);
assert.ok(snapshotUsageBuffer().statementsWithoutRowMetadata > 0);
__resetUsageBufferForTests();

// A synchronous statement-preparation failure must requeue rather than silently
// discard already buffered usage increments.
let prepUnavailable = false;
const preparationD1 = {
  ...writeD1,
  prepare() {
    if (prepUnavailable) throw new Error('D1 preparation unavailable');
    return writeD1.prepare();
  },
};
await bufferPersist({ TOKEN_STATS_DB: preparationD1 }, 'delivered', usageEvent);
await bufferPersist({ TOKEN_STATS_DB: preparationD1 }, 'delivered', usageEvent);
prepUnavailable = true;
await assert.rejects(flushUsageBuffer(), /D1 preparation unavailable/);
assert.equal(snapshotUsageBuffer().pendingEvents, 1);
prepUnavailable = false;
await flushUsageBuffer();
assert.equal(snapshotUsageBuffer().pendingEvents, 0);
__resetUsageBufferForTests();

console.log('Upstream D1 summary and buffered write diagnostics passed without extra D1 reads or writes.');
