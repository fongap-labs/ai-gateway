#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Regression: independent D1 reads overlap after buffered writes flush, with
// identical cumulative/hourly results and the old-schema fallback retained.
import assert from 'node:assert/strict';
import { loadUpstreamSummary } from '../src/observability/token-usage-store/upstream-queries.ts';
import { __resetUsageBufferForTests } from '../packages/usage-store/buffer.ts';

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
totalsGate.resolve(currentTotals);
hourlyGate.resolve(currentHourly);
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
assert.deepEqual(legacySql.filter((read) => read.modern).map((read) => read.isTotals).sort(), [false, true]);
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
__resetUsageBufferForTests();
console.log('Upstream D1 summary: concurrent independent reads, legacy schema, and error boundary passed.');
