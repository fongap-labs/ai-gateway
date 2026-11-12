#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Deterministic free-tier reliability contracts. No keys or Provider calls.

import assert from 'node:assert/strict';
import { classifyUpstreamStatus, rateLimitWindowOf } from '../src/reliability/classify.ts';
import { __resetTier1StateForTests, recordTier1QuotaReport, recordTier1QuotaSignal, recordTier1Ttft, tier1QuotaState } from '../src/reliability/tier1-state.ts';
import { calculateTier1Score, TIER1_TTFT_CONFIDENCE_SAMPLES } from '../src/scheduler/tier1-scoring.ts';

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
assert.equal(
  recordTier1QuotaReport('baseline', { remainingRequests: 1, limitRequests: 100, resetAtMs: now + 60_000 }, now),
  true,
);
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

console.log('Free Tier 1 429 recovery and TTFT-confidence contracts passed offline.');
