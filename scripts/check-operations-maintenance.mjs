#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Offline contract for the standalone Operations scheduled entrypoint.
import assert from 'node:assert/strict';
import { scheduled } from '../operations/standalone.ts';

const FIXED_NOW = Date.UTC(2026, 10, 10, 10);
const HOUR_MS = 60 * 60 * 1000;
const hour = (value) => `${new Date(value).toISOString().slice(0, 13)}:00:00Z`;
const sourceRows = [
  {
    hour: hour(FIXED_NOW),
    input_tokens: 5,
    output_tokens: 2,
    cache_creation_input_tokens: 1,
    cache_read_input_tokens: 2,
    total_tokens: 7,
    requests: 1,
    usage_reports: 1,
    usage_missing: 1,
    upstream_input_tokens: 6,
    upstream_output_tokens: 2,
    upstream_cache_creation_input_tokens: 3,
    upstream_cache_read_input_tokens: 2,
    upstream_total_tokens: 8,
    upstream_attempts: 2,
    upstream_usage_reports: 2,
    upstream_usage_missing: 2,
    upstream_effective_input_tokens: 4,
    upstream_cache_observed_read_tokens: 1,
    upstream_cache_observed_input_tokens: 5,
    upstream_cache_read_reports: 1,
  },
  {
    hour: hour(FIXED_NOW - HOUR_MS),
    input_tokens: 7,
    output_tokens: 3,
    total_tokens: 10,
    requests: 2,
    usage_reports: 2,
    upstream_input_tokens: 8,
    upstream_output_tokens: 3,
    upstream_total_tokens: 11,
    upstream_attempts: 3,
    upstream_usage_reports: 3,
  },
];

function mockD1({ failBatchTable } = {}) {
  const tables = new Map([
    ['token_usage_hourly', new Map(sourceRows.map((row, index) => [`${row.hour}:${index}`, structuredClone(row)]))],
    ['token_usage_daily', new Map()],
    ['token_usage_weekly', new Map()],
    ['token_usage_model_hourly', new Map()],
  ]);
  const deletes = [];
  const upserts = [];
  return {
    tables,
    deletes,
    upserts,
    prepare(sql) {
      let values = [];
      return {
        bind(...bound) {
          values = bound;
          return this;
        },
        async all() {
          const table = /\bFROM\s+([a-z_]+)/i.exec(sql)?.[1];
          assert.ok(table, `mock SELECT has a table: ${sql}`);
          return { results: [...(tables.get(table)?.values() || [])].map((row) => structuredClone(row)) };
        },
        async run() {
          const match = /\bDELETE\s+FROM\s+([a-z_]+)\s+WHERE\s+([a-z_]+)\s*</i.exec(sql);
          assert.ok(match, `mock DELETE has a table and cutoff: ${sql}`);
          deletes.push({ table: match[1], column: match[2], cutoff: values[0] });
          return { meta: { changes: 0 } };
        },
        sql,
        get values() {
          return values;
        },
      };
    },
    async batch(statements) {
      const prepared = statements.map((statement) => {
        const match = /\bINSERT\s+INTO\s+([a-z_]+)\s*\(([^)]+)\)/i.exec(statement.sql);
        assert.ok(match, `mock batch has an INSERT target: ${statement.sql}`);
        return { table: match[1], columns: match[2].split(',').map((column) => column.trim()), values: statement.values };
      });
      if (prepared.some(({ table }) => table === failBatchTable)) throw new Error('mock D1 batch failed');
      for (const entry of prepared) {
        const row = Object.fromEntries(entry.columns.map((column, index) => [column, entry.values[index]]));
        tables.get(entry.table).set(String(entry.values[0]), row);
        upserts.push({ table: entry.table, key: entry.values[0] });
      }
      return prepared.map(() => ({ success: true }));
    },
  };
}

const originalNow = Date.now;
const originalError = console.error;
Date.now = () => FIXED_NOW;
try {
  await assert.rejects(scheduled({}, {}), /requires private TOKEN_STATS_DB D1 binding/);

  const d1 = mockD1();
  await scheduled({}, { TOKEN_STATS_DB: d1 });
  const firstDaily = structuredClone([...d1.tables.get('token_usage_daily').values()]);
  const firstWeekly = structuredClone([...d1.tables.get('token_usage_weekly').values()]);
  assert.equal(firstDaily.length, 1, 'hourly rows in the same display day combine into one daily row');
  assert.equal(firstWeekly.length, 1, 'daily rows combine into one weekly row');
  assert.equal(firstDaily[0].input_tokens, 12);
  assert.equal(firstDaily[0].requests, 3);
  assert.equal(firstDaily[0].upstream_attempts, 5, 'physical upstream attempts are included in rollups');
  assert.equal(firstWeekly[0].input_tokens, 12);
  assert.equal(firstWeekly[0].upstream_attempts, 5);

  // Every hourly metric retains its SQL column position through both
  // materializations. Distinct values catch a shifted positional bind even
  // if daily and weekly accidentally shift together.
  const expectedMetrics = {
    input_tokens: 12,
    output_tokens: 5,
    cache_creation_input_tokens: 1,
    cache_read_input_tokens: 2,
    total_tokens: 17,
    requests: 3,
    usage_reports: 3,
    usage_missing: 1,
    upstream_input_tokens: 14,
    upstream_output_tokens: 5,
    upstream_cache_creation_input_tokens: 3,
    upstream_cache_read_input_tokens: 2,
    upstream_total_tokens: 19,
    upstream_attempts: 5,
    upstream_usage_reports: 5,
    upstream_usage_missing: 2,
    upstream_effective_input_tokens: 4,
    upstream_cache_observed_read_tokens: 1,
    upstream_cache_observed_input_tokens: 5,
    upstream_cache_read_reports: 1,
  };
  for (const [field, expected] of Object.entries(expectedMetrics)) {
    assert.equal(firstDaily[0][field], expected, `daily aggregate: ${field}`);
    assert.equal(firstWeekly[0][field], expected, `weekly aggregate: ${field}`);
  }

  await scheduled({}, { TOKEN_STATS_DB: d1 });
  assert.deepEqual([...d1.tables.get('token_usage_daily').values()], firstDaily, 'repeated daily maintenance upserts instead of double-counting');
  assert.deepEqual([...d1.tables.get('token_usage_weekly').values()], firstWeekly, 'repeated weekly maintenance upserts instead of double-counting');
  assert.equal(d1.tables.get('token_usage_daily').size, 1);
  assert.equal(d1.tables.get('token_usage_weekly').size, 1);
  assert.equal(d1.deletes.filter(({ table }) => ['token_usage_hourly', 'token_usage_daily', 'token_usage_weekly'].includes(table)).length, 6);

  const failedD1 = mockD1({ failBatchTable: 'token_usage_daily' });
  const errors = [];
  console.error = (...args) => errors.push(args);
  await scheduled({}, { TOKEN_STATS_DB: failedD1 });
  assert.ok(errors.length > 0, 'failed aggregation is visible in the maintenance diagnostics');
  assert.deepEqual(
    failedD1.deletes.filter(({ table }) => ['token_usage_hourly', 'token_usage_daily', 'token_usage_weekly'].includes(table)),
    [],
    'failed rollups must retain all source rows and defer retention deletes',
  );
  assert.equal(failedD1.tables.get('token_usage_hourly').size, sourceRows.length);
} finally {
  Date.now = originalNow;
  console.error = originalError;
}

console.log('Standalone Operations maintenance contracts passed: required D1, repeat-safe rollups and no source cleanup after aggregate failure.');
