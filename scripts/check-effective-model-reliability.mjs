#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Offline model-family attribution regression. No Provider, secrets, KV or D1.

import assert from 'node:assert/strict';
import { recordNodeSuccess, recordTier1NonStreamTtft } from '../apps/gateway/attempt/observability.ts';
import { recordOutcome } from '../apps/gateway/attempt/outcome.ts';
import { classifyUpstreamStatus } from '../src/reliability/classify.ts';
import { __resetTier1StateForTests, getTier1Model, getTier1ModelPerf } from '../src/reliability/tier1-state.ts';

const source = 'Code-Ultra';
const effective = 'Code-Max';
const node = {
  id: 'free-key-model-target',
  tier: 'tier-1',
  provider: 'offline-provider',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  models: { [source]: 'physical-ultra', [effective]: 'physical-max' },
};
const logs = [];
const makeState = () => ({
  requestedModel: source,
  requestedModelAlias: source,
  requestId: 'offline-fallback',
  attempted: new Set(),
  attempts: [],
  logicalAttempts: 0,
  dispatches: 0,
  failureKinds: {},
  maxAttempts: 8,
  maxDispatches: 8,
  hedges: 0,
  logger: { info(message) { logs.push(message); }, debug() {}, error() {} },
});
const makeContext = (state) => ({
  state,
  requestedModel: source,
  reqDescriptor: { model: effective, route: 'openai_chat', protocol: 'openai', surface: 'chat_completions', bodyChars: 20 },
  tier1ReleaseToken: null,
  env: {},
  ctx: { waitUntil() {} },
  logger: state.logger,
  requestId: 'offline-fallback',
  upstreamProtocol: 'openai',
  surface: 'chat_completions',
  attemptStartMs: Date.now() - 150,
  attemptSettlement: { observedUsage: null, settled: true },
});

__resetTier1StateForTests();
// The request-level alias intentionally differs from the physical dispatch
// descriptor. Only the descriptor is the evidence of which model failed.
const state = makeState();
const c = makeContext(state);
recordOutcome(state, node, classifyUpstreamStatus(503, new Headers(), {}, Date.now(), 'temporary unavailable'), c, { status: 503, latencyMs: 200 });
assert.equal(getTier1Model(node.id, effective).consecutiveFailures, 1);
assert.equal(getTier1Model(node.id, source).consecutiveFailures, 0);
assert.equal(state.attempts[0].effective_model, effective);
assert.equal(state.attempts[0].upstream_model, 'physical-max');
assert.equal(state.sameNodeRetry.model, effective);

// The same failure class on another pass must not poison the original alias.
recordOutcome(state, node, classifyUpstreamStatus(503, new Headers(), {}, Date.now(), 'temporary unavailable'), makeContext(state), {
  status: 503,
  latencyMs: 200,
});
assert.equal(getTier1Model(node.id, effective).consecutiveFailures, 2);
assert.equal(getTier1Model(node.id, source).cooldownUntil, 0);

__resetTier1StateForTests();
const throttled = makeState();
recordOutcome(throttled, node, classifyUpstreamStatus(429, new Headers({ 'Retry-After': '15' }), {}, Date.now(), 'requests per minute'), makeContext(throttled), {
  status: 429,
  latencyMs: 80,
});
assert.ok(getTier1Model(node.id, effective).cooldownUntil > Date.now());
assert.equal(getTier1Model(node.id, source).cooldownUntil, 0);

__resetTier1StateForTests();
const success = makeState();
const successContext = makeContext(success);
recordTier1NonStreamTtft(successContext, node, {}, () => true);
assert.ok((getTier1ModelPerf(node.id, effective)?.ttftEwma ?? 0) > 0);
assert.equal(getTier1ModelPerf(node.id, source)?.ttftEwma ?? null, null);

recordOutcome(success, node, classifyUpstreamStatus(503, new Headers(), {}, Date.now(), 'temporary unavailable'), makeContext(success), {
  status: 503,
  latencyMs: 100,
});
assert.equal(getTier1Model(node.id, effective).consecutiveFailures, 1);
recordNodeSuccess(successContext, node, 120);
assert.equal(getTier1Model(node.id, effective).consecutiveFailures, 0);
assert.equal(getTier1Model(node.id, source).consecutiveFailures, 0);
assert.ok(!JSON.stringify(success.attempts).includes('physical-ultra'), 'source model must not be blamed for target failure');
__resetTier1StateForTests();

console.log('Tier 1 effective-model error, quota, TTFT and recovery attribution contracts passed offline.');
