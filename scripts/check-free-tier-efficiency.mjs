#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Deterministic free-tier reliability contracts. No keys or Provider calls.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { __resetTier1AffinityForTests, readTier1Affinity } from '../apps/gateway/scheduling/tier1-affinity.ts';
import { pickTier1Candidate } from '../apps/gateway/scheduling/tier1-scheduler.ts';
import { classifyUpstreamStatus, rateLimitWindowOf } from '../src/reliability/classify.ts';
import {
  __resetTier1StateForTests,
  recordTier1QuotaReport,
  recordTier1QuotaSignal,
  recordTier1Ttft,
  tier1QuotaState,
} from '../src/reliability/tier1-state.ts';
import { calculateTier1Score, TIER1_TTFT_CONFIDENCE_SAMPLES } from '../src/scheduler/tier1-scoring.ts';

// Keep Free D1 budgeting tied to the actual buffer constants. A previous
// operations document assumed five-minute windows while code used one minute,
// underestimating the maximum number of SQL statements under steady traffic.
const bufferSource = readFileSync(new URL('../packages/usage-store/buffer.ts', import.meta.url), 'utf8');
const budgetDoc = readFileSync(new URL('../docs/operations/free-tier-budget.md', import.meta.url), 'utf8');
const intervalLiteral = /const FLUSH_INTERVAL_MS = ([0-9_]+);/.exec(bufferSource)?.[1];
const thresholdLiteral = /const FLUSH_EVENT_THRESHOLD = ([0-9_]+);/.exec(bufferSource)?.[1];
assert.ok(intervalLiteral && thresholdLiteral, 'usage buffer budget constants must be discoverable');
const flushIntervalMs = Number(intervalLiteral.replaceAll('_', ''));
const flushThreshold = Number(thresholdLiteral.replaceAll('_', ''));
assert.ok(flushIntervalMs > 0 && flushIntervalMs % 60_000 === 0, 'budget model assumes whole-minute flush intervals');
assert.ok(flushThreshold > 0);
const flushMinutes = flushIntervalMs / 60_000;
const markdownTick = String.fromCharCode(96);
const expectedIntervalLabel = '默认刷新间隔为 ' + markdownTick + flushIntervalMs / 1_000 + ' 秒' + markdownTick;
assert.ok(budgetDoc.includes(expectedIntervalLabel), 'budget must state the actual default flush interval');
assert.ok(budgetDoc.includes(markdownTick + flushThreshold + markdownTick + ' 个事件'), 'budget must state the actual event threshold');
assert.match(budgetDoc, /定时器.*不能保证|不能保证.*定时器/, 'budget must state detached timer durability limits');
for (const scenario of [
  { label: '5 个隔离区各活跃 8 小时', isolates: 5, hours: 8, kinds: 2, modelRows: 6 },
  { label: '20 个隔离区全天活跃', isolates: 20, hours: 24, kinds: 2, modelRows: 10 },
]) {
  const rows = budgetDoc.split(String.fromCharCode(10)).filter((line) => line.includes(scenario.label));
  assert.equal(rows.length, 1, `budget must contain one row for ${scenario.label}`);
  const cells = rows[0].split('|').map((part) => part.trim());
  const batches = (scenario.isolates * scenario.hours * 60) / flushMinutes;
  const statements = batches * (2 * scenario.kinds + scenario.modelRows);
  assert.equal(Number(cells[2].replaceAll(',', '')), batches, 'budget batch estimate must match flush cadence');
  assert.equal(Number(cells[4].replaceAll(',', '')), statements, 'budget statement estimate must match model cardinality');
}

assert.equal(rateLimitWindowOf('quota exceeded'), 'quota');
assert.equal(rateLimitWindowOf('free quota exhausted'), 'quota');
assert.equal(rateLimitWindowOf('resource exhausted'), 'quota');
assert.equal(rateLimitWindowOf('too many requests; quota exceeded'), 'window');
assert.equal(rateLimitWindowOf('Quota exceeded for requests PerMinute'), 'window');
assert.equal(rateLimitWindowOf('Quota exceeded for requests PerDay'), 'quota');
assert.equal(rateLimitWindowOf('Daily quota exhausted'), 'quota');
assert.equal(rateLimitWindowOf('quota exceeded', 28_000), 'window');
assert.equal(rateLimitWindowOf('quota exceeded', 3_600_000), 'quota');
assert.equal(rateLimitWindowOf('Requests per minute reached; daily quota also listed', 30_000), 'window');
assert.equal(rateLimitWindowOf('Requests per minute reached; daily quota also listed', 3_600_000), 'quota');

const minute = classifyUpstreamStatus(429, new Headers({ 'Retry-After': '28' }), {}, Date.now(), 'quota exceeded');
assert.equal(minute.kind, 'rate_limit');
assert.equal(minute.action, 'rotate');
assert.equal(minute.rateLimitWindow, 'window');
assert.equal(minute.retryAfterMs, 28_000);
const unknown = classifyUpstreamStatus(429, new Headers(), {}, Date.now(), 'quota exceeded');
assert.equal(unknown.action, 'rotate');
assert.equal(unknown.rateLimitWindow, 'quota');
const daily = classifyUpstreamStatus(429, new Headers(), {}, Date.now(), 'Daily quota exhausted');
assert.equal(daily.rateLimitWindow, 'quota');

__resetTier1StateForTests();
const model = 'Free-Model';
const nodes = [
  { id: 'baseline', provider: 'test-provider', models: { [model]: 'upstream' } },
  { id: 'warming', provider: 'test-provider', models: { [model]: 'upstream' } },
];
for (let i = 0; i < TIER1_TTFT_CONFIDENCE_SAMPLES; i++) {
  assert.equal(recordTier1Ttft('baseline', model, 900), true);
}
assert.equal(recordTier1Ttft('warming', model, 1_800), true);
const firstScore = calculateTier1Score(nodes[1], model, nodes);
const healthyFreeScore = calculateTier1Score(nodes[0], model, nodes);
const now = Date.now();
// A nearly depleted *but still usable* free key must not be artificially
// demoted when it may still complete the next request.
assert.equal(recordTier1QuotaSignal('baseline', { remainingRatio: 0.01, resetAtMs: now + 60_000 }, now), true);
assert.equal(tier1QuotaState('baseline', now), 'near_limit');
assert.equal(calculateTier1Score(nodes[0], model, nodes), healthyFreeScore);
assert.equal(recordTier1QuotaReport('baseline', { remainingRequests: 1, limitRequests: 100, resetAtMs: now + 60_000 }, now), true);
assert.equal(tier1QuotaState('baseline', now), 'near_limit');
assert.equal(calculateTier1Score(nodes[0], model, nodes), healthyFreeScore);
assert.equal(recordTier1QuotaSignal('baseline', { remainingRatio: 0, resetAtMs: now + 60_000 }, now), true);
assert.equal(tier1QuotaState('baseline', now), 'exhausted_until');
assert.ok(firstScore > 1_000, 'observed slow node should have a bounded TTFT penalty');
for (let i = 1; i < TIER1_TTFT_CONFIDENCE_SAMPLES; i++) {
  assert.equal(recordTier1Ttft('warming', model, 1_800), true);
}
const matureScore = calculateTier1Score(nodes[1], model, nodes);
assert.ok(matureScore > firstScore, 'one slow sample must not penalize a new free key as strongly as established evidence');
__resetTier1StateForTests();

// Free-cost-guard affinity is intentionally disabled: no digest, KV read, or
// escape-window work should occur. Explicitly enabling writes restores the
// historical session-binding read path without changing the default.
__resetTier1AffinityForTests();
let affinityReads = 0;
const affinityKV = {
  async get() {
    affinityReads++;
    return 'sticky-key';
  },
  async put() {},
};
const sessionId = 'free-cost-guard-session-123456';
const costGuardedEnv = { AIG_COST_GUARDS: 'true', TIER1_AFFINITY: affinityKV };
assert.equal(await readTier1Affinity(costGuardedEnv, sessionId), undefined);
assert.equal(affinityReads, 0, 'disabled affinity must consume no KV reads');
const explicitlyDisabledEnv = { AIG_AFFINITY_WRITE: '0', TIER1_AFFINITY: affinityKV };
assert.equal(await readTier1Affinity(explicitlyDisabledEnv, sessionId), undefined);
assert.equal(affinityReads, 0, 'explicitly disabled affinity also consumes no KV reads');
const explicitlyEnabledEnv = { ...costGuardedEnv, AIG_AFFINITY_WRITE: '1' };
assert.equal(await readTier1Affinity(explicitlyEnabledEnv, sessionId), 'sticky-key');
assert.equal(await readTier1Affinity(explicitlyEnabledEnv, sessionId), 'sticky-key');
assert.equal(affinityReads, 1, 'enabled affinity reuses the isolate cache');
__resetTier1AffinityForTests();

// With the affinity candidate in the middle, P2C must sample either peer
// uniformly without excluding or duplicating a candidate.
__resetTier1StateForTests();
const routingModel = 'free-p2c';
const routingNodes = ['peer-a', 'preferred', 'peer-b'].map((id) => ({
  id,
  tier: 'tier-1',
  provider: 'test-provider',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  baseUrl: 'https://provider.test',
  credential: 'test',
  priority: 1,
  models: { [routingModel]: routingModel },
}));
for (const [id, ttft] of [
  ['peer-a', 100],
  ['preferred', 12_000],
  ['peer-b', 200],
]) {
  for (let i = 0; i < TIER1_TTFT_CONFIDENCE_SAMPLES; i++) recordTier1Ttft(id, routingModel, ttft);
}
const routeRequest = { model: routingModel, protocol: 'openai', surface: 'chat_completions', bodyChars: 100 };
for (const [rngValue, expected] of [
  [0, 'peer-a'],
  [0.99999, 'peer-b'],
]) {
  const pick = pickTier1Candidate(routingNodes, routeRequest, new Set(), {
    affinityAccountId: 'preferred',
    evaluateAffinity: true,
    rng: () => rngValue,
  });
  assert.equal(pick?.node?.id, expected, 'P2C must choose the deterministic eligible peer');
  assert.equal(pick?.escapedFromAffinity, true);
}
__resetTier1StateForTests();

console.log('Free Tier 1 429 recovery and TTFT-confidence contracts passed offline.');
