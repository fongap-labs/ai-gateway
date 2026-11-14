#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Client-agnostic wire contract: errors are protocol-native, compact and
// replay-safe. This is not a substitute for live SDK/production acceptance.
import assert from 'node:assert/strict';
import { gatewayError } from '../apps/gateway/response/errors.ts';
import { streamInterruptionChunk } from '../apps/gateway/response/response-helpers.ts';

const request = new Request('https://gateway.invalid/v1/chat/completions', { method: 'POST' });
const routes = ['openai_chat', 'openai_responses', 'anthropic_messages'];
const fixtures = [
  {
    status: 429,
    code: 'gateway_no_dispatchable_node',
    message: 'No eligible nodes are available.',
    details: { requested_model: 'Code-Max', attempts: 0, failure_kinds: { rate_limit: 2 } },
    retryAfter: '2',
    retryable: true,
    suppressReplay: false,
  },
  {
    status: 503,
    code: 'gateway_attempt_budget_exhausted',
    message: 'Transient failures exhausted the model family.',
    details: {
      requested_model: 'Code-Max',
      attempts: 8,
      failure_kinds: { rate_limit: 3, headers_timeout: 2 },
      failover_summary: { private_node: 'never-expose-me' },
    },
    retryAfter: '10',
    retryable: true,
    suppressReplay: true,
  },
  {
    status: 504,
    code: 'gateway_failover_budget_exhausted',
    message: 'Gateway request budget exhausted.',
    details: { requested_model: 'Code-Max', attempts: 3, failure_kinds: { headers_timeout: 3 } },
    retryAfter: null,
    retryable: false,
    suppressReplay: true,
  },
  {
    status: 400,
    code: 'gateway_unsupported_request_field',
    message: 'The request contains an unsupported field.',
    details: { failure_kind: 'unsupported_request_field', unsupported_fields: ['unknown_field'] },
    retryAfter: null,
    retryable: false,
    suppressReplay: true,
  },
];

for (const route of routes) {
  for (const fixture of fixtures) {
    const response = gatewayError(
      request,
      {},
      route,
      fixture.status,
      fixture.message,
      'wire-contract-id',
      fixture.details,
      fixture.retryAfter ? { 'retry-after': fixture.retryAfter } : undefined,
      fixture.code,
      fixture.retryable,
    );
    assert.equal(response.status, fixture.status, route);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.headers.get('x-request-id'), 'wire-contract-id');
    assert.equal(response.headers.get('x-gateway-error-code'), fixture.code);
    assert.equal(response.headers.get('retry-after'), fixture.retryAfter);
    assert.equal(response.headers.get('x-should-retry') === 'false', fixture.suppressReplay);
    const body = await response.json();
    const error = body.error;
    assert.equal(typeof error?.message, 'string');
    assert.ok(error.message.startsWith(String(fixture.status) + ' | '));
    assert.equal(error.message.includes('\n'), false);
    assert.ok(error.message.length <= 160);
    assert.equal(JSON.stringify(body).includes('never-expose-me'), false);
    if (route === 'anthropic_messages') {
      assert.equal(body.type, 'error');
      assert.equal(typeof error.type, 'string');
      assert.equal(response.headers.get('request-id'), 'wire-contract-id');
    } else if (route === 'openai_responses') {
      assert.equal(error.code, null, 'Responses keeps its native SDK body');
      assert.equal(error.details, undefined, 'Responses has no custom details');
    } else {
      assert.equal(body.type, undefined);
    }
    if (route !== 'openai_responses') {
      assert.equal(error.details.gateway_code, fixture.code);
      if (fixture.retryAfter) assert.equal(error.details.retry_after_ms, Number(fixture.retryAfter) * 1000);
      if (fixture.status === 503) {
        // This PR can merge independently of the optional compact retry
        // evidence fix; both forms must remain wire-compatible.
        const evidence = error.details.failure_kinds;
        assert.ok(
          evidence === undefined || (Object.keys(evidence).length === 1 && evidence.headers_timeout === 2),
          'never expose the full failover classification graph',
        );
      }
    }
  }
}

for (const route of routes) {
  const chunk = new TextDecoder().decode(streamInterruptionChunk(route, 'stream-id', 'secret bearer token with whitespace'));
  assert.equal(chunk.includes('secret bearer'), false, 'never leak an arbitrary upstream reason in client SSE');
  const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine);
  const event = JSON.parse(dataLine.slice(6));
  const error = route === 'anthropic_messages' ? event.error : route === 'openai_responses' ? event : event.error;
  assert.match(error.message, /interrupted \(unknown\)/);
  assert.ok(chunk.endsWith('\n\n'));
  const known = new TextDecoder().decode(streamInterruptionChunk(route, 'stream-id', 'first_event_timeout'));
  assert.match(known, /first_event_timeout/);
}

console.log('Client wire matrix: Chat, Responses, Anthropic, terminal statuses and committed SSE errors passed.');
