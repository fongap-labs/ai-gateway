#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Quota lease lifecycle contracts:
//   acquire -> reserve -> execute -> settle -> release
//
//   - unknown quota is a no-op pass-through (no fabricated hard limits; the
//     reactive adaptive-429 + cooldown behavior is untouched)
//   - provider-reported remaining drives a reservation counter so concurrent
//     admission cannot all pass against the tail of a window
//   - settle consumes the request reservation and reports actual token usage;
//     duplicate settle/release are idempotent
//   - release before settle (abort / pre-execution failure / hedge loss)
//     restores the reservation
//   - quota windows classify near_limit (score demotion) and exhausted_until
//     (eligibility gate + blocking wait) before the next 429

import assert from 'node:assert/strict';
import {
  claimTier1Slot, makeTier1ReleaseToken, releaseTier1Slot, settleTier1Quota,
  recordTier1QuotaReport, recordTier1QuotaSignal, tier1QuotaState,
  tier1BlockingWaitMs, isTier1Eligible, __resetTier1StateForTests,
} from '../src/reliability/tier1-state.ts';
import { extractQuotaSignal } from '../src/reliability/quota-signal.ts';
import { calculateTier1Score } from '../src/scheduler/tier1-scoring.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}`); console.error(e?.stack || e); process.exitCode = 1; }
}

const node = (id) => ({
  id, tier: 'tier-1', provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'],
  baseUrl: `https://${id}.example.com/v1`, credential: 'k', priority: 10, models: { 'Code-Max': 'up' },
});
const req = { protocol: 'openai', surface: 'chat_completions', model: 'Code-Max' };

test('unknown quota never denies admission (reactive path preserved)', () => {
  __resetTier1StateForTests();
  for (let i = 0; i < 100; i++) {
    assert.equal(claimTier1Slot(node('u1'), 1000 + i, 'Code-Max', null), true,
      'without a provider report, every claim is admitted exactly as before');
    const token = makeTier1ReleaseToken('u1');
    releaseTier1Slot('u1', token);
  }
  assert.equal(tier1QuotaState('u1'), 'normal');
});

test('quota signal extraction reads both protocol conventions', () => {
  const openai = extractQuotaSignal('openai', new Headers({
    'x-ratelimit-remaining-requests': '9',
    'x-ratelimit-remaining-tokens': '5000',
    'x-ratelimit-limit-requests': '10',
    'x-ratelimit-reset-requests': '60s',
  }), 1000);
  assert.deepEqual(
    { remainingRequests: openai?.remainingRequests, limitRequests: openai?.limitRequests, remainingTokens: openai?.remainingTokens },
    { remainingRequests: 9, limitRequests: 10, remainingTokens: 5000 },
  );
  assert.ok(openai?.resetAtMs === 61_000, 'reset marker resolves to a wall-clock instant');

  const anthropic = extractQuotaSignal('anthropic', new Headers({
    'anthropic-ratelimit-requests-remaining': '3',
    'anthropic-ratelimit-requests-limit': '100',
    'anthropic-ratelimit-requests-reset': '30',
  }), 2000);
  assert.equal(anthropic?.remainingRequests, 3);
  assert.equal(anthropic?.resetAtMs, 32_000);

  assert.equal(extractQuotaSignal('openai', new Headers({}), 0), null,
    'no markers -> no signal -> unknown quota');
});

test('reported remaining=10 admits exactly 10 concurrent, not 20', () => {
  __resetTier1StateForTests();
  recordTier1QuotaReport('race', { remainingRequests: 10, limitRequests: 100 }, 1000);
  let admitted = 0;
  const tokens = [];
  for (let i = 0; i < 20; i++) {
    if (claimTier1Slot(node('race'), 1001 + i, 'Code-Max', null)) {
      admitted++;
      tokens.push(makeTier1ReleaseToken('race'));
    }
  }
  assert.equal(admitted, 10, 'the 11th..20th concurrent claims are denied against a reported tail of 10');
  assert.equal(isTier1Eligible(node('race'), req, 1001), false,
    'the exhausted reservation also fails eligibility');
  for (const token of tokens) releaseTier1Slot('race', token);
});

test('release before settle restores the reservation (abort / pre-execution)', () => {
  __resetTier1StateForTests();
  recordTier1QuotaReport('abort', { remainingRequests: 1, limitRequests: 10 }, 1000);
  assert.equal(claimTier1Slot(node('abort'), 1001, 'Code-Max', null), true);
  const token = makeTier1ReleaseToken('abort');
  releaseTier1Slot('abort', token);
  assert.equal(claimTier1Slot(node('abort'), 1002, 'Code-Max', null), true,
    'an aborted claim gives the reservation back');
  releaseTier1Slot('abort', makeTier1ReleaseToken('abort'));
});

test('settle consumes the request reservation and reports actual usage', () => {
  __resetTier1StateForTests();
  recordTier1QuotaReport('settle', { remainingRequests: 2, remainingTokens: 10_000, limitRequests: 10, limitTokens: 100_000 }, 1000);
  // Claim + settle consumes one slot; token usage is subtracted.
  assert.equal(claimTier1Slot(node('settle'), 1001, 'Code-Max', null), true);
  const tokenA = makeTier1ReleaseToken('settle');
  settleTier1Quota('settle', tokenA, 3_500);
  releaseTier1Slot('settle', tokenA);
  // Claim + settle consumes the second slot.
  assert.equal(claimTier1Slot(node('settle'), 1002, 'Code-Max', null), true);
  const tokenB = makeTier1ReleaseToken('settle');
  settleTier1Quota('settle', tokenB, 1_000);
  releaseTier1Slot('settle', tokenB);
  // Both reservations were settled (consumed), so admission now waits.
  assert.equal(claimTier1Slot(node('settle'), 1003, 'Code-Max', null), false,
    'settled leases do not give reservations back');
  // A fresher provider report reconciles the window: 2 reported, 0 outstanding.
  recordTier1QuotaReport('settle', { remainingRequests: 2, limitRequests: 10 }, 1004);
  // Claim + release WITHOUT settle restores, so the tail is reusable.
  assert.equal(claimTier1Slot(node('settle'), 1005, 'Code-Max', null), true);
  releaseTier1Slot('settle', makeTier1ReleaseToken('settle'));
  assert.equal(claimTier1Slot(node('settle'), 1006, 'Code-Max', null), true,
    'an aborted claim gives its reservation back');
  releaseTier1Slot('settle', makeTier1ReleaseToken('settle'));
});

test('duplicate settle and duplicate release are idempotent (no leaks)', () => {
  __resetTier1StateForTests();
  recordTier1QuotaReport('idem', { remainingRequests: 2, limitRequests: 4 }, 1000);
  assert.equal(claimTier1Slot(node('idem'), 1001, 'Code-Max', null), true);
  const token = makeTier1ReleaseToken('idem');
  settleTier1Quota('idem', token, 10);
  settleTier1Quota('idem', token, 10);
  settleTier1Quota('idem', token, 10);
  releaseTier1Slot('idem', token);
  assert.equal(releaseTier1Slot('idem', token), false, 'second release is a no-op');
  releaseTier1Slot('idem', token);
  recordTier1QuotaReport('idem', { remainingRequests: 2, limitRequests: 4 }, 1002);
  assert.equal(claimTier1Slot(node('idem'), 1003, 'Code-Max', null), true);
  releaseTier1Slot('idem', makeTier1ReleaseToken('idem'));
});

test('near_limit demotes the node score before a 429 ever arrives', () => {
  __resetTier1StateForTests();
  const a = node('fresh');
  const b = node('tail');
  recordTier1QuotaReport('tail', { remainingRequests: 1, limitRequests: 100 }, 1000);
  assert.equal(tier1QuotaState('tail', 1001), 'near_limit');
  assert.ok(calculateTier1Score(b, 'Code-Max', [a, b], 1, 1001) > calculateTier1Score(a, 'Code-Max', [a, b], 1, 1001),
    'the near-limit node scores worse than an equally unknown healthy node');
});

test('exhausted_until gates eligibility and surfaces the window wait, then auto-clears', () => {
  __resetTier1StateForTests();
  const resetAt = 60_000;
  recordTier1QuotaReport('window', { remainingRequests: 0, limitRequests: 10, resetAtMs: resetAt }, 1000);
  assert.equal(tier1QuotaState('window', 2000), 'exhausted_until');
  assert.equal(isTier1Eligible(node('window'), req, 2000), false);
  assert.equal(claimTier1Slot(node('window'), 2001, 'Code-Max', null), false);
  assert.equal(tier1BlockingWaitMs(node('window'), 'Code-Max', 2000), resetAt - 2000,
    'blocking wait reflects the quota window for Retry-After');
  assert.equal(tier1QuotaState('window', resetAt + 1), 'normal', 'window expiry auto-restores');
  assert.equal(isTier1Eligible(node('window'), req, resetAt + 1), true);
});

test('legacy ratio writer keeps its pinned semantics', () => {
  __resetTier1StateForTests();
  assert.equal(recordTier1QuotaSignal('legacy', { remainingRatio: 0.05 }), true);
  assert.equal(tier1QuotaState('legacy'), 'near_limit');
  assert.equal(recordTier1QuotaSignal('legacy', { remainingRatio: 0 }), true);
  assert.equal(tier1QuotaState('legacy'), 'near_limit', 'zero without reset classifies near_limit');
  const at = Date.now() + 50_000;
  assert.equal(recordTier1QuotaSignal('legacy', { remainingRatio: 0, resetAtMs: at }), true);
  assert.equal(tier1QuotaState('legacy'), 'exhausted_until');
  assert.equal(recordTier1QuotaSignal('legacy', { remainingRatio: 0.5 }), true);
  assert.equal(tier1QuotaState('legacy'), 'normal');
  assert.equal(recordTier1QuotaSignal('legacy', { remainingRatio: 1.5 }), false, 'out-of-range ratios are rejected');
});

test('subscription window hints mark the entitlement exhausted until reset', () => {
  __resetTier1StateForTests();
  recordTier1QuotaReport('sub', { remainingRequests: 0, resetAtMs: 90_000, source: 'subscription-window' }, 1000);
  assert.equal(tier1QuotaState('sub', 1500), 'exhausted_until');
  assert.equal(claimTier1Slot(node('sub'), 1501, 'Code-Max', null), false);
  assert.equal(isTier1Eligible(node('sub'), req, 1501), false);
});

console.log(`[quota-lease-test] ${passed} checks passed`);
