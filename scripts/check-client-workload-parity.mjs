#!/usr/bin/env node
import assert from 'node:assert/strict';
import { __resetRetryBudgetForTests, RetrySlot, snapshotRetryBudget } from '../apps/gateway/reliability/retry-budget.ts';
import { gatewayError } from '../apps/gateway/response/errors.ts';
import { classifyUpstreamStatus } from '../src/reliability/classify.ts';

const model = 'Code-Max';
const workloads = [
  { name: 'OpenCode', route: 'openai_chat', path: '/v1/chat/completions' },
  { name: 'DeepSeek Harness', route: 'anthropic_messages', path: '/v1/messages' },
  { name: 'OpenAI Responses SDK', route: 'openai_responses', path: '/v1/responses' },
];

const upstreamFailures = [
  { status: 422, body: '{"error":{"code":"invalid_json"}}', expected: 'stop', kind: 'client' },
  { status: 429, body: 'Too many requests', headers: { 'retry-after': '3' }, expected: 'rotate', kind: 'rate_limit' },
  { status: 503, body: 'Service temporarily unavailable', headers: { 'retry-after': '7' }, expected: 'rotate', kind: 'server' },
  { status: 504, body: 'Gateway timeout', expected: 'rotate', kind: 'server' },
];

for (const workload of workloads) {
  for (const failure of upstreamFailures) {
    const classification = classifyUpstreamStatus(failure.status, new Headers(failure.headers), {}, Date.now(), failure.body);
    assert.equal(classification.action, failure.expected, workload.name + ':' + failure.status);
    assert.equal(classification.kind, failure.kind, workload.name + ':' + failure.status);
    if (failure.status === 503) {
      assert.equal(classification.cooldownMs, 7_000, '503 backoff must survive adapter normalization');
    }
    const canRetry = classification.action === 'rotate';
    const request = new Request('https://gateway.invalid' + workload.path, { method: 'POST' });
    const response = gatewayError(
      request,
      {},
      workload.route,
      failure.status,
      failure.body,
      workload.name.replaceAll(' ', '-').toLowerCase() + '-fixture',
      { requested_model: model, attempts: 1, failure_kinds: { [classification.kind]: 1 } },
      failure.headers,
      canRetry ? 'gateway_upstream_exhausted' : 'gateway_invalid_request',
      canRetry,
    );
    assert.equal(response.status, failure.status);
    assert.equal(response.headers.get('x-gateway-retryable'), String(canRetry || failure.status === 429));
    assert.equal((await response.json()).error.message.startsWith(String(failure.status) + ' | '), true);
    if (failure.status === 503) assert.equal(response.headers.get('retry-after'), '7');
    if (!canRetry) assert.equal(response.headers.get('x-should-retry'), 'false');
  }
}

__resetRetryBudgetForTests();
const active = Array.from({ length: 12 }, () => new RetrySlot());
assert.equal(active[0].tryAcquire(), true);
assert.equal(active[1].tryAcquire(), true);
assert.equal(active[2].tryAcquire(), true);
assert.equal(active[3].tryAcquire(), false, 'speculative retries must remain concurrency-bounded');
assert.equal(active[3].tryAcquire(true), true, 'independent credential can use recovery lane');
active[0].release();
active[3].release();
assert.equal(active[4].tryAcquire(), true, 'completed physical retry returns admission to other requests');
for (const slot of active) slot.end();
assert.equal(snapshotRetryBudget().active, 0);
assert.equal(snapshotRetryBudget().retrying, 0);

console.log('Cross-client failure parity passed: protocol surfaces, explicit 503 backoff, 422 stop, independent recovery slots.');
