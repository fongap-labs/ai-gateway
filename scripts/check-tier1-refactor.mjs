#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Deterministic Tier 1 state boundaries. No Provider/network/credentials.
import assert from 'node:assert/strict';
import {
  __resetTier1StateForTests,
  adoptTier1Cooldown,
  applyTier1Outcome,
  claimTier1Slot,
  classifyTier1Failure,
  decideTier1RateLimitScope,
  getTier1Account,
  getTier1ModelPerf,
  makeTier1ReleaseToken,
  maybeTransitionToHalfOpen,
  recordTier1QuotaReport,
  recordTier1QuotaSignal,
  recordTier1Success,
  releaseTier1Slot,
  settleTier1Quota,
  snapshotTier1AccountRuntime,
  snapshotTier1Runtime,
  tier1AccountInFlight,
  tier1LongCooldowns,
  tier1QuotaState,
} from '../src/reliability/tier1-state.ts';

const now = Date.now();
const node = {
  id: 'test-tier1-account',
  tier: 'tier-1',
  provider: 'openai',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  models: { 'chat-test': 'provider-test' },
};

__resetTier1StateForTests();
assert.equal(snapshotTier1Runtime(node.id, 'chat-test', now).state, 'configured');
assert.equal(snapshotTier1AccountRuntime(node.id, ['chat-test'], now).state, 'configured');
assert.equal(tier1AccountInFlight(node.id), 0);

assert.equal(recordTier1QuotaReport(node.id, { remainingRequests: 2, limitRequests: 10, resetAtMs: now + 60_000, source: 'test' }, now), true);
assert.equal(tier1QuotaState(node.id, now), 'normal');
assert.equal(getTier1Account(node.id).quotaRemainingRequests, 2);
assert.equal(claimTier1Slot(node, now, 'chat-test'), true);
const first = makeTier1ReleaseToken(node.id, 'chat-test');
assert.equal(claimTier1Slot(node, now, 'chat-test'), true);
const second = makeTier1ReleaseToken(node.id, 'chat-test');
assert.equal(claimTier1Slot(node, now, 'chat-test'), false, 'absolute quota must block a third concurrent reservation');
assert.equal(releaseTier1Slot(node.id, first), true);
assert.equal(releaseTier1Slot(node.id, first), false, 'release is idempotent');
assert.equal(getTier1Account(node.id).quotaRemainingRequests, 1, 'an uncommitted reservation is restored');
settleTier1Quota(node.id, second, 3);
settleTier1Quota(node.id, second, 3);
assert.equal(releaseTier1Slot(node.id, second), true);
assert.equal(getTier1Account(node.id).quotaRemainingRequests, 1, 'a settled reservation is not refunded');
assert.equal(tier1AccountInFlight(node.id), 0);

assert.equal(recordTier1QuotaSignal(node.id, { remainingRatio: 0, resetAtMs: now + 60_000 }, now), true);
assert.equal(tier1QuotaState(node.id, now), 'exhausted_until');
assert.equal(snapshotTier1Runtime(node.id, 'chat-test', now).quota_state, 'exhausted_until');
assert.equal(tier1QuotaState(node.id, now + 60_001), 'normal', 'quota expiry projection must not require a writer');
assert.equal(recordTier1QuotaSignal(node.id, { remainingRatio: -1 }, now), false);

__resetTier1StateForTests();
assert.equal(decideTier1RateLimitScope(node.id, 'chat-test', now), 'model');
assert.equal(decideTier1RateLimitScope(node.id, 'other-model', now + 1), 'account');
const throttle = classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'model', retryAfterMs: 2_000 });
assert.equal(throttle.scope, 'model');
applyTier1Outcome(node.id, 'chat-test', throttle, now);
assert.equal(snapshotTier1Runtime(node.id, 'chat-test', now).cooldown_remaining_ms, 2_000);
assert.equal(snapshotTier1Runtime(node.id, 'chat-test', now).account_cooldown_remaining_ms, 0);
const timeout = classifyTier1Failure({ kind: 'headers_timeout' });
assert.equal(timeout.backoff, 'timeout');
assert.equal(timeout.scope, 'model');

__resetTier1StateForTests();
for (let i = 0; i < 3; i++) {
  applyTier1Outcome(node.id, 'chat-test', { action: 'cooldown', scope: 'model', reason: 'server', counted: true, cooldownMs: 60_000 }, now);
}
assert.equal(getTier1ModelPerf(node.id, 'chat-test')?.failureState, 'cooldown');
maybeTransitionToHalfOpen(node.id, 'chat-test', now + 60_001);
assert.equal(getTier1ModelPerf(node.id, 'chat-test')?.failureState, 'half_open');
recordTier1Success(node.id, 'chat-test', now + 60_001);
assert.equal(getTier1ModelPerf(node.id, 'chat-test')?.failureState, 'half_open');
recordTier1Success(node.id, 'chat-test', now + 60_002);
assert.equal(getTier1ModelPerf(node.id, 'chat-test')?.failureState, 'normal');

__resetTier1StateForTests();
adoptTier1Cooldown({ node: node.id, until: now + 60_000, reason: 'auth' }, now);
const before = tier1LongCooldowns(node.id, 30_000, now);
assert.equal(before.length, 1);
assert.equal(before[0].node, node.id);
assert.equal(snapshotTier1AccountRuntime(node.id, ['chat-test'], now).state, 'cooldown');
assert.deepEqual(tier1LongCooldowns(node.id, 30_000, now), before, 'snapshots never mutate the cooldown');
__resetTier1StateForTests();
console.log('Tier 1 refactor contracts: singleton store, quota lease, 429 scope, cooldown, half-open and snapshots passed.');
