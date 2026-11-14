#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Gateway terminal failures must be compact, status-first and preserve retry headers.
import assert from 'node:assert/strict';
import { gatewayError } from '../apps/gateway/response/errors.ts';

const model = 'Code-Max';
const request = new Request('https://gateway.invalid/v1/messages', { method: 'POST' });
const diagnostic = {
  requested_model: model,
  attempts: 8,
  dispatches: 8,
  hedges: 0,
  failure_kinds: { rate_limit: 3, client: 2, headers_timeout: 2, first_event_timeout: 1 },
  failover_summary: { model_switches: 4, distinct_models: 3, tier1_dispatches: 8, tier2_dispatches: 0, other_dispatches: 0 },
};
const cases = [
  ['openai_chat', 'error'],
  ['anthropic_messages', 'error'],
  ['openai_responses', 'error'],
];
for (const [route, field] of cases) {
  const response = gatewayError(
    request,
    {},
    route,
    503,
    'Transient failures exhausted the compatible-model failover plan for "Code-Max". Retry after the advertised delay.',
    'example-request-id',
    diagnostic,
    { 'retry-after': '9' },
    'gateway_attempt_budget_exhausted',
    true,
  );
  const json = await response.json();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '9');
  assert.equal(response.headers.get('x-gateway-retryable'), 'true');
  assert.equal(response.headers.get('x-gateway-error-code'), 'gateway_attempt_budget_exhausted');
  assert.equal(response.headers.get('x-gateway-attempts'), '8');
  assert.equal(response.headers.get('x-gateway-failure-kinds'), 'client:2,first_event_timeout:1,headers_timeout:2,rate_limit:3');
  assert.equal(response.headers.get('x-should-retry'), 'false', 'deferred retry contract must not change');
  assert.equal(response.headers.get('x-request-id'), 'example-request-id');
  const message = json[field]?.message;
  assert.equal(message, '503 | Code-Max temporarily unavailable after 8 attempts; retry after 9s.');
  assert.equal(message.includes('\n'), false);
  assert.ok(message.length < 100);
  assert.equal(JSON.stringify(json).includes('failover_summary'), false, 'diagnostic object must not flood the client');
  assert.equal(JSON.stringify(json).includes('failure_kinds'), false);
  if (route !== 'openai_responses')
    assert.deepEqual(json[field]?.details, { gateway_code: 'gateway_attempt_budget_exhausted', retryable: true, retry_after_ms: 9000 });
  if (route === 'openai_responses') assert.equal(json.error.code, null, 'Responses SDK contract is unchanged');
  if (route === 'anthropic_messages') assert.equal(json.type, 'error');
}

const blocked = gatewayError(
  request,
  {},
  'openai_chat',
  429,
  'No eligible nodes are available.',
  'blocked-id',
  { requested_model: model, attempts: 0, failure_kinds: { rate_limit: 3 } },
  { 'retry-after': '2' },
  'gateway_no_dispatchable_node',
  true,
);
const blockedJson = await blocked.json();
assert.match(blockedJson.error.message, /^429 \| No eligible nodes/);
assert.equal(blockedJson.error.details?.gateway_code, 'gateway_no_dispatchable_node');
assert.equal(blocked.headers.get('retry-after'), '2');

const invalid = gatewayError(
  request,
  {},
  'openai_chat',
  400,
  'The request contains a field that is not supported by any configured target.\nDo not retry.',
  'bad-id',
  { unsupported_fields: ['unknown_field'] },
  undefined,
  'gateway_unsupported_request_field',
  false,
);
const invalidJson = await invalid.json();
assert.equal(invalid.status, 400);
assert.match(invalidJson.error.message, /^400 \| /);
assert.ok(!invalidJson.error.message.includes('\n'));
assert.equal(invalid.headers.get('x-gateway-retryable'), 'false');

const debug = gatewayError(
  request,
  {},
  'anthropic_messages',
  502,
  'All nodes failed.',
  'debug-id',
  { ...diagnostic, attempts_detail: [{ node_id: 'private-node', status: 502 }] },
  undefined,
  'gateway_upstream_exhausted',
  false,
);
const debugBody = await debug.json();
assert.match(debugBody.error.message, /^502 \| /);
assert.ok(Array.isArray(debugBody.error.details.attempts_detail), 'explicit debug detail remains opt-in');

const deadline = gatewayError(
  request,
  {},
  'openai_chat',
  504,
  'Gateway failover budget exhausted after eight physical dispatches.',
  'deadline-id',
  { requested_model: model, attempts: 8, dispatches: 8, failure_kinds: { headers_timeout: 8 } },
  undefined,
  'gateway_failover_budget_exhausted',
  false,
);
const deadlineJson = await deadline.json();
assert.equal(deadlineJson.error.message, '504 | Code-Max temporarily unavailable after 8 attempts.');
assert.equal(deadline.headers.get('x-gateway-error-code'), 'gateway_failover_budget_exhausted');
assert.equal(deadline.headers.get('x-request-id'), 'deadline-id');
assert.equal(JSON.stringify(deadlineJson).includes('headers_timeout'), false);

console.log('Concise Gateway errors: status-first, one line, SDK shapes, detailed headers, and retry semantics passed.');
