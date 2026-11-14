#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Independent Key fallback can use bounded extra retry capacity, never unbounded fanout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  __resetRetryBudgetForTests,
  isIndependentKeyRecovery,
  isSpeculativeRetryAfter,
  RETRY_BUDGET_RATIO,
  RETRY_INDEPENDENT_KEY_RATIO,
  RetrySlot,
  snapshotRetryBudget,
} from '../apps/gateway/reliability/retry-budget.ts';

assert.equal(RETRY_BUDGET_RATIO, 0.2);
assert.equal(RETRY_INDEPENDENT_KEY_RATIO, 0.4);
assert.equal(isSpeculativeRetryAfter('headers_timeout'), true);
assert.equal(isSpeculativeRetryAfter('rate_limit'), false);

const sameProvider = {
  id: 'slot-a',
  tier: 'tier-1',
  provider: 'provider-a',
  baseUrl: 'https://example.invalid/v1',
  keyGroup: 'shared-credential',
};
assert.equal(isIndependentKeyRecovery(sameProvider, { ...sameProvider, id: 'slot-b' }), false);
assert.equal(isIndependentKeyRecovery(sameProvider, { ...sameProvider, id: 'slot-c', keyGroup: 'another-credential' }), true);
assert.equal(isIndependentKeyRecovery(undefined, sameProvider), false);

__resetRetryBudgetForTests();
const active = Array.from({ length: 10 }, () => new RetrySlot());
assert.equal(active[0].tryAcquire(), true);
assert.equal(active[1].tryAcquire(), true);
assert.equal(active[2].tryAcquire(), true);
assert.equal(active[3].tryAcquire(), false, 'same-Key speculative retry hits normal 20% lane');
assert.equal(active[3].tryAcquire(true), true, 'independent Key can use guarded recovery lane');
assert.equal(active[4].tryAcquire(true), false, 'independent recovery still has a hard per-isolate budget');
assert.deepEqual(snapshotRetryBudget(), { active: 10, retrying: 4, denied: 2 });
active[0].end();
assert.equal(active[4].tryAcquire(true), true, 'released recovery slot can be reused');
assert.equal(active[4].tryAcquire(), true, 'a held retry slot is idempotent');
for (const slot of active) slot.end();
assert.equal(active[4].tryAcquire(true), false, 'a completed request cannot reacquire');
assert.deepEqual(snapshotRetryBudget(), { active: 0, retrying: 0, denied: 2 });

const tierLoop = readFileSync(new URL('../apps/gateway/tier-loop.ts', import.meta.url), 'utf8');
assert.match(tierLoop, /if \(!mayDispatchNextAttempt\(state, node\)\)/);
assert.match(tierLoop, /releaseTier1Slot\(node\.id, pick\.tier1ReleaseToken/);
assert.doesNotMatch(tierLoop, /if \(!mayDispatchNextAttempt\(state\)\) return null;/);
console.log('Independent-Key retry budget passed: strict normal lane, bounded recovery lane, shared-credential exclusion, slot cleanup.');
