#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Offline model-family attribution regression. No Provider, secrets, KV or D1.

import assert from 'node:assert/strict';
import { recordNodeSuccess, recordTier1NonStreamTtft } from '../apps/gateway/attempt/observability.ts';
import { buildBudgetExhaustedResponse, buildClientErrorResponse, summarizeFailoverAttempts } from '../apps/gateway/response/errors.ts';
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
  logger: {
    info(message) {
      logs.push(message);
    },
    debug() {},
    error() {},
  },
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
recordOutcome(
  throttled,
  node,
  classifyUpstreamStatus(429, new Headers({ 'Retry-After': '15' }), {}, Date.now(), 'requests per minute'),
  makeContext(throttled),
  {
    status: 429,
    latencyMs: 80,
  },
);
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

// Public diagnostic summary proves that cross-model and cross-tier fallback
// really dispatched, while protecting Key IDs, Provider and physical models.
const diagnosticAttempts = [
  { tier: 'tier-1', node_id: 'secret-node-1', provider: 'secret-provider', effective_model: 'Code-Max', dispatched: false },
  { tier: 'tier-1', node_id: 'secret-node-1', provider: 'secret-provider', upstream_model: 'secret-physical', effective_model: 'Code-Max', dispatched: true },
  { tier: 'tier-1', node_id: 'secret-node-2', effective_model: 'Code-Max', dispatched: true },
  { tier: 'tier-2', node_id: 'secret-node-3', effective_model: 'Code-Pro', dispatched: true },
];
const failover = summarizeFailoverAttempts(diagnosticAttempts).failover_summary;
assert.deepEqual(failover, {
  model_switches: 1,
  distinct_models: 2,
  tier1_dispatches: 2,
  tier2_dispatches: 1,
  other_dispatches: 0,
  truncated: false,
});
assert.deepEqual(summarizeFailoverAttempts([{ dispatched: false, effective_model: 'Code-Max' }]), {});
assert.equal(JSON.stringify(failover).includes('secret-'), false);
const longTrace = Array.from({ length: 90 }, (_, i) => ({
  tier: i % 2 === 0 ? 'tier-1' : 'tier-2',
  effective_model: i % 2 === 0 ? 'Code-Max' : 'Code-Pro',
  dispatched: true,
}));
const bounded = summarizeFailoverAttempts(longTrace).failover_summary;
assert.equal(bounded?.truncated, true);
assert.equal((bounded?.tier1_dispatches ?? 0) + (bounded?.tier2_dispatches ?? 0), 64);
const diagnosticState = {
  attempts: diagnosticAttempts,
  logicalAttempts: 3,
  dispatches: 3,
  hedges: 0,
  failureKinds: { rate_limit: 1, headers_timeout: 1, server: 1 },
};
const diagnosticRequest = new Request('https://gateway.example.invalid/v1/chat/completions', { method: 'POST' });
const rejectedResponse = buildClientErrorResponse(
  diagnosticRequest, {}, 'openai_chat', 'offline-request', 'Code-Max', 422, 'secret private upstream detail', diagnosticState, false,
);
assert.equal(rejectedResponse.status, 422);
const rejectedText = await rejectedResponse.text();
assert.deepEqual(JSON.parse(rejectedText).error.details.failover_summary, failover);
assert.equal(rejectedText.includes('secret-'), false);
const exhaustedResponse = buildBudgetExhaustedResponse(
  diagnosticRequest, {}, 'openai_chat', 'offline-request', 'Code-Max', diagnosticState, false,
);
assert.equal(exhaustedResponse.status, 504);
const exhaustedText = await exhaustedResponse.text();
assert.deepEqual(JSON.parse(exhaustedText).error.details.failover_summary, failover);
assert.equal(exhaustedText.includes('secret-'), false);

console.log('Tier 1 effective-model attribution and anonymous failover diagnostics contracts passed offline.');
