#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Contract for reserve-aware request budgeting. The gateway should give the
// preferred candidate a realistic first-output window while preserving a
// bounded escape path for later failover candidates.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attemptBudgetSliceMs,
  attemptBudgetWindowMs,
  attemptFirstEventTimeoutMs,
  attemptHeadersTimeoutMs,
  getLimits,
  MIN_FAILOVER_RESERVE_MS,
} from '../src/config/timeouts.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Keep the equal-share primitive stable for callers/tests that explicitly need
// it; the live dispatch path uses the reserve-aware allocator below.
assert.equal(attemptBudgetSliceMs(60_000, 5), 12_000);
assert.equal(attemptBudgetSliceMs(240_000, 5), 48_000);

// Default production-shaped request: 120s budget / 6 possible attempts.
// The allocator reserves 5s for each later candidate and gives the preferred
// candidate the remaining 95s while preserving the full 3/2/1 family plan.
assert.equal(MIN_FAILOVER_RESERVE_MS, 5_000);
assert.equal(attemptBudgetWindowMs(120_000, 6), 95_000);

const defaults = getLimits({});
assert.equal(defaults.headersTimeoutMs, 30_000);
assert.equal(defaults.firstEventTimeoutMs, 60_000);
assert.equal(defaults.failoverBudgetMs, 120_000);
assert.equal(attemptHeadersTimeoutMs(defaults.headersTimeoutMs, 95_000, 1), 30_000);
assert.equal(attemptFirstEventTimeoutMs(defaults.firstEventTimeoutMs, 65_000, 1), 60_000);

// A smaller explicit budget still degrades predictably for operators that
// intentionally override the default.
assert.equal(attemptBudgetWindowMs(60_000, 3), 50_000);

// Once only one candidate remains it may use the whole remaining request
// budget; unused time from earlier fast failures naturally carries forward.
assert.equal(attemptBudgetWindowMs(37_000, 1), 37_000);

// Tight budgets degrade to an equal split instead of starving the tail.
assert.equal(attemptBudgetWindowMs(10_000, 5), 2_000);
assert.equal(attemptBudgetWindowMs(15_000, 3), 5_000);
assert.equal(attemptBudgetWindowMs(0, 5), 1);

// If every candidate consumes its entire worst-case window, the reserve is
// still usable in sequence rather than being consumed by the first attempt.
let remaining = 120_000;
for (let attempts = 6; attempts > 1; attempts--) {
  const window = attemptBudgetWindowMs(remaining, attempts);
  remaining -= window;
}
assert.equal(remaining, 5_000, 'the last candidate must retain its escape window');

// Composition contract: real dispatch must use reserve-aware allocation; the
// equal-share helper must not accidentally return to the live path during a
// refactor. Hedge twins must continue inheriting the primary absolute deadline.
const dispatchSource = readFileSync(join(root, 'src/request/attempt/dispatch.ts'), 'utf8');
assert.match(dispatchSource, /attemptBudgetWindowMs\(remainingBudgetMs,\s*remainingDispatchableAttempts\)/,
  'dispatch must allocate reserve-aware attempt windows');
assert.doesNotMatch(dispatchSource, /attemptBudgetSliceMs\(remainingBudgetMs,\s*remainingDispatchableAttempts\)/,
  'dispatch must not regress to equal-share request slicing');

const hedgeSource = readFileSync(join(root, 'src/request/attempt/hedge.ts'), 'utf8');
assert.match(hedgeSource, /attemptDeadlineMs:\s*primaryArgs\.attemptDeadlineMs/,
  'hedge twin must share the primary logical-attempt deadline');

console.log('attempt budget contract tests passed.');
