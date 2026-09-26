#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Unified runtime-state interface contracts:
//   - both backends (Tier 1 adaptive runtime, Tier 2/3 node state) satisfy
//     the same RuntimeStateStore read contract
//   - projections are honest: a field a backend does not track is null,
//     never a fabricated value
//   - unknown quota surfaces as 'unknown' (reactive path governs); reported
//     quota surfaces as near_limit / exhausted
//   - upper layers resolve state through runtimeStateStoreFor(node), never
//     by importing backend internals per tier

import assert from 'node:assert/strict';
import { runtimeStateStoreFor, tier1RuntimeStateStore, nodeRuntimeStateStore } from '../src/reliability/runtime-state-store.ts';
import {
  claimTier1Slot, makeTier1ReleaseToken, releaseTier1Slot, settleTier1Quota,
  recordTier1QuotaReport, recordTier1Success, recordTier1Ttft, __resetTier1StateForTests,
} from '../src/reliability/tier1-state.ts';
import {
  acquireSlot, recordTtft, recordSuccess, recordFailure, __resetAllStateForTests,
} from '../src/reliability/node-state.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}`); console.error(e?.stack || e); process.exitCode = 1; }
}

test('both backends satisfy the same RuntimeStateStore contract', () => {
  for (const store of [tier1RuntimeStateStore, nodeRuntimeStateStore]) {
    assert.equal(typeof store.endpoint, 'function');
    assert.equal(typeof store.account, 'function');
    assert.equal(typeof store.model, 'function');
  }
  assert.equal(runtimeStateStoreFor({ tier: 'tier-1' }), tier1RuntimeStateStore);
  assert.equal(runtimeStateStoreFor({ tier: 'tier-2' }), nodeRuntimeStateStore);
  assert.equal(runtimeStateStoreFor({ tier: 'tier-3' }), nodeRuntimeStateStore);
});

test('tier-1 projection is honest: no fabricated health, endpoint circuit, or model latency', () => {
  __resetTier1StateForTests();
  const endpoint = tier1RuntimeStateStore.endpoint('a1');
  assert.equal(endpoint.availability, 'available');
  assert.equal(endpoint.circuit, null, 'tier 1 circuit state is model-scoped, not endpoint-scoped');
  assert.equal(endpoint.health, null, 'tier 1 has no numeric health score');
  assert.equal(endpoint.inFlight, 0);
  const account = tier1RuntimeStateStore.account('a1');
  assert.equal(account.quota.state, 'unknown', 'no provider report -> unknown quota');
  assert.equal(account.disabled, false);
  assert.equal(tier1RuntimeStateStore.model('a1', 'never-observed'), null,
    'unobserved model pairs surface null, not fabricated entries');
});

test('tier-1 projections reflect real state transitions end to end', () => {
  __resetTier1StateForTests();
  assert.equal(claimTier1Slot({ id: 'a2', tier: 'tier-1', provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'], baseUrl: 'https://a2.example.com/v1', credential: 'k', priority: 10, models: { 'Code-Max': 'up' } }, 1000, 'Code-Max', null), true);
  const token = makeTier1ReleaseToken('a2');
  assert.equal(tier1RuntimeStateStore.account('a2').inFlight, 1);
  recordTier1Ttft('a2', 'Code-Max', 120, 1001);
  recordTier1Success('a2', 'Code-Max', 1002);
  settleTier1Quota('a2', token, 500);
  releaseTier1Slot('a2', token);
  const model = tier1RuntimeStateStore.model('a2', 'Code-Max');
  assert.equal(model.supported, true);
  assert.equal(model.failureState, 'normal');
  assert.equal(model.sampleCount, 1);
  assert.equal(model.ttftEwmaMs, 120);
  assert.equal(tier1RuntimeStateStore.account('a2').inFlight, 0);
  assert.equal(tier1RuntimeStateStore.account('a2').quota.state, 'unknown');
});

test('tier-1 quota projections surface near_limit, exhausted, and reset', () => {
  __resetTier1StateForTests();
  recordTier1QuotaReport('a3', { remainingRequests: 2, limitRequests: 100, resetAtMs: 90_000 }, 1000);
  assert.equal(tier1RuntimeStateStore.account('a3', 1001).quota.state, 'near_limit');
  assert.equal(tier1RuntimeStateStore.account('a3', 1001).quota.remainingRequests, 2);
  assert.equal(tier1RuntimeStateStore.account('a3', 1001).quota.source, null);
  recordTier1QuotaReport('a3', { remainingRequests: 0, resetAtMs: 90_000, source: 'subscription-window' }, 1002);
  const exhausted = tier1RuntimeStateStore.account('a3', 1003).quota;
  assert.equal(exhausted.state, 'exhausted');
  assert.equal(exhausted.source, 'subscription-window');
  // After the window rolls, the account returns to unknown quota.
  assert.equal(tier1RuntimeStateStore.account('a3', 90_001).quota.state, 'unknown');
});

test('tier-2/3 projections reflect node-state semantics without fabricating accounts', () => {
  __resetAllStateForTests();
  const endpoint = nodeRuntimeStateStore.endpoint('n1');
  assert.equal(endpoint.availability, 'available');
  assert.equal(endpoint.circuit, 'closed');
  assert.equal(endpoint.health, 50, 'tier 2/3 node state has a real numeric health score');
  assert.equal(nodeRuntimeStateStore.account('n1').disabled, false);
  assert.equal(nodeRuntimeStateStore.account('n1').quota.state, 'unknown', 'tier 2/3 has no per-account quota');
  assert.equal(nodeRuntimeStateStore.model('n1', 'unobserved'), null);

  acquireSlot('n1', 1000);
  assert.equal(nodeRuntimeStateStore.endpoint('n1').inFlight, 1);
  recordTtft('n1', 90, 'Solo', { source: 'passive' });
  recordSuccess('n1', 200, 'Solo', 1001);
  recordFailure('n1', { counted: true, cooldownMs: 500, reason: 'network' }, 1002);
  const after = nodeRuntimeStateStore.endpoint('n1', 1002);
  assert.equal(after.inFlight, 0);
  assert.equal(after.circuit, 'closed', 'one transient failure does not open the circuit');
  assert.equal(nodeRuntimeStateStore.model('n1', 'Solo').ttftEwmaMs, 90);
});

console.log(`[runtime-state-contract-test] ${passed} checks passed`);
