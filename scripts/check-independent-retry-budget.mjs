#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  __resetRetryBudgetForTests,
  isCredentialWideFailure,
  isIndependentKeyRecovery,
  isSpeculativeRetryAfter,
  preferUntriedCredentials,
  RETRY_BUDGET_RATIO,
  RETRY_INDEPENDENT_KEY_RATIO,
  RetrySlot,
  snapshotRetryBudget,
} from '../apps/gateway/reliability/retry-budget.ts';

assert.equal(RETRY_BUDGET_RATIO, 0.2);
assert.equal(RETRY_INDEPENDENT_KEY_RATIO, 0.4);
assert.equal(isSpeculativeRetryAfter('headers_timeout'), true);
assert.equal(isSpeculativeRetryAfter('rate_limit'), false);

assert.equal(isCredentialWideFailure({ dispatched: false, status: 401, kind: 'auth' }), false);
assert.equal(isCredentialWideFailure({ dispatched: true, status: 401, kind: 'auth' }), true);
assert.equal(isCredentialWideFailure({ dispatched: true, status: 403, kind: 'auth' }), false);
assert.equal(isCredentialWideFailure({ dispatched: true, status: 422, kind: 'client' }), false);
assert.equal(isCredentialWideFailure({ dispatched: true, status: 504, kind: 'headers_timeout' }), false);
assert.equal(isCredentialWideFailure({ dispatched: true, status: 429, kind: 'rate_limit', rate_limit_scope: 'model' }), false);
assert.equal(isCredentialWideFailure({ dispatched: true, status: 429, kind: 'rate_limit', rate_limit_scope: 'account' }), true);

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

const sameKeyPeer = { ...sameProvider, id: 'slot-b' };
const otherKeyPeer = { ...sameProvider, id: 'slot-c', keyGroup: 'another-credential' };
const attempted = new Set(['slot-a']);
const preferred = preferUntriedCredentials([sameKeyPeer, otherKeyPeer], [sameProvider, sameKeyPeer, otherKeyPeer], ['slot-a'], attempted);
assert.deepEqual([...(preferred ?? [])].sort(), ['slot-a', 'slot-b'], 'prefer an untried Key over a second node sharing the failed credential');
assert.equal(attempted.has('slot-b'), false, 'request-wide preference must not mutate the actual attempted set');
assert.equal(preferUntriedCredentials([otherKeyPeer], [sameProvider, otherKeyPeer], ['slot-a'], attempted), null);
assert.equal(preferUntriedCredentials([sameKeyPeer], [sameProvider, sameKeyPeer], ['unknown-node'], attempted), null);
assert.deepEqual(
  [...preferUntriedCredentials([sameKeyPeer], [sameProvider, sameKeyPeer], ['slot-a'], attempted)],
  ['slot-a', 'slot-b'],
  'a pool containing only a failed shared credential must not be retried',
);

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
assert.match(tierLoop, /preferUntriedCredentials\(/);
assert.match(tierLoop, /state\.attempts\.filter\(\(attempt\) => attempt\.dispatched === true\)/, 'skip pre-dispatch refusals');
assert.match(tierLoop, /dispatchedAttempts\.filter\(isCredentialWideFailure\)/, 'hard-exclude only proven credential-wide failures');
assert.match(tierLoop, /const pick =\s*\(preferredAttempted \? pickForTier/, 'prefer independent Key first');
assert.match(
  tierLoop,
  /pickForTier\(tierNumber, tiers\[tierNumber\], reqDescriptor, strictlyAttempted, pickOpts\)/,
  'retain a bounded same-Key sibling-model fallback for model-scoped failures',
);
assert.match(tierLoop, /releaseTier1Slot\(node\.id, pick\.tier1ReleaseToken/);
assert.doesNotMatch(tierLoop, /if \(!mayDispatchNextAttempt\(state\)\) return null;/);
console.log('Independent-Key retry budget passed: strict normal lane, bounded recovery lane, shared-credential exclusion, slot cleanup.');
