#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// v6: non-streaming Matrix replies are collected only in private Inference.
import assert from 'node:assert/strict';
import { INFERENCE_TRANSLATED_OBJECT_FORMAT, isTranslatedObjectEnvelope } from '../packages/contracts/execution.ts';
import { handleInferenceCenterRequest } from '../src/inference/inference-center-entry.ts';
import { buildInferenceRequest } from '../src/inference/inference-client-request.ts';

const key = 'integration-v6-object-key-at-least-32-characters';
const node = {
  id: 'test-v6-node',
  provider: 'openai',
  base_url: 'https://provider.invalid/v1',
  models: { 'chat-test': 'gpt-test-upstream' },
};
const env = {
  AIG_INFERENCE_AUTH_KEY: key,
  AIG_INFERENCE_SERVICE: {
    fetch: async () => {
      throw new Error('Gateway Service Binding mock is never used by center');
    },
  },
  AIG_TIER2_NODES_01: JSON.stringify([node]),
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ [node.id]: 'mock-physical-credential' }),
};
const client = new Request('https://gateway.invalid/v1/messages', {
  method: 'POST',
  headers: { authorization: 'Bearer user-private', cookie: 'secret=value' },
});
const clientBody = { model: 'chat-test', max_tokens: 128, messages: [{ role: 'user', content: 'Hello' }] };
const budget = { mode: 'error', cfg: { maxEvents: 100, maxOutputUnits: 200, maxToolEvents: 30, maxToolArgUnits: 1000, maxOutputTokens: 0 } };
function inbound(overrides = {}) {
  const deadlineMs = overrides.deadlineMs ?? Date.now() + 90_000;
  return buildInferenceRequest(env, {
    request: client,
    requestId: '12345678-1234-4234-8234-123456789012',
    node: { id: node.id },
    logicalModel: 'chat-test',
    surface: 'chat_completions',
    inputSurface: 'messages',
    returnObject: true,
    deadlineMs,
    upstreamHeadersDeadlineMs: overrides.upstreamHeadersDeadlineMs ?? deadlineMs - 1_000,
    bufferedResponseDeadlineMs: overrides.bufferedResponseDeadlineMs ?? deadlineMs - 250,
    body: JSON.stringify(clientBody),
    ...overrides,
  });
}
const usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
const chunks = [
  {
    id: 'cmpl-test',
    object: 'chat.completion.chunk',
    model: 'gpt-test-upstream',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
  },
  { id: 'cmpl-test', object: 'chat.completion.chunk', model: 'gpt-test-upstream', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { id: 'cmpl-test', object: 'chat.completion.chunk', model: 'gpt-test-upstream', choices: [], usage },
];
const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
const originalFetch = globalThis.fetch;
let attempts = 0;
let providerText = sse;
let providerType = 'text/event-stream';
try {
  globalThis.fetch = async (_url, options) => {
    attempts += 1;
    const sent = JSON.parse(options.body);
    assert.equal(sent.stream, true, 'v6 must execute one forced-stream Provider request');
    assert.equal(sent.model, 'gpt-test-upstream');
    const headers = new Headers(options.headers);
    assert.equal(headers.has('x-aig-return-object'), false);
    assert.equal(headers.has('authorization') && headers.get('authorization') === 'Bearer user-private', false);
    assert.equal(headers.has('cookie'), false);
    return new Response(providerText, { status: 200, headers: { 'content-type': providerType } });
  };

  const ticket = inbound();
  assert.equal(ticket.headers.get('x-aig-contract-version'), '6');
  assert.equal(ticket.headers.get('x-aig-return-object'), 'true');
  assert.equal(ticket.headers.has('x-aig-conversion-prefer-nonstream'), false);
  const result = await handleInferenceCenterRequest(ticket, env);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-aig-result'), 'dispatched');
  assert.equal(result.headers.get('x-aig-response-format'), INFERENCE_TRANSLATED_OBJECT_FORMAT);
  assert.equal(result.headers.get('content-type'), 'application/json');
  const envelope = await result.json();
  assert.equal(isTranslatedObjectEnvelope(envelope), true);
  assert.equal(envelope.response.type, 'message');
  assert.equal(envelope.response.content[0].text, 'hello');
  assert.deepEqual(envelope.upstreamUsage, usage);
  assert.equal(attempts, 1);

  const invalidVersion = inbound();
  invalidVersion.headers.set('x-aig-contract-version', '3');
  assert.equal((await handleInferenceCenterRequest(invalidVersion, env)).status, 400);
  const invalidClientStream = inbound({ body: JSON.stringify({ ...clientBody, stream: true }) });
  assert.equal((await handleInferenceCenterRequest(invalidClientStream, env)).status, 400);
  const missingMarker = inbound();
  missingMarker.headers.delete('x-aig-return-object');
  assert.equal((await handleInferenceCenterRequest(missingMarker, env)).status, 400);
  const incompatible = inbound({ preferNonstream: true });
  assert.equal(incompatible.headers.get('x-aig-contract-version'), '3');
  assert.equal(attempts, 1);

  const native = {
    id: 'cmpl-test',
    object: 'chat.completion',
    model: 'gpt-test-upstream',
    choices: [{ index: 0, message: { role: 'assistant', content: 'JSON fallback' }, finish_reason: 'stop' }],
    usage,
  };
  providerText = JSON.stringify(native);
  providerType = 'application/json';
  const object = await handleInferenceCenterRequest(inbound(), env);
  assert.equal(object.headers.get('x-aig-response-format'), INFERENCE_TRANSLATED_OBJECT_FORMAT);
  assert.equal((await object.json()).response.content[0].text, 'JSON fallback');
  assert.equal(attempts, 2);

  providerText = '{not JSON';
  const bad = await handleInferenceCenterRequest(inbound(), env);
  assert.equal(bad.status, 502);
  assert.equal(bad.headers.get('x-aig-result'), 'dispatched');
  assert.equal(bad.headers.get('x-aig-error-kind'), 'center_converted_object_invalid');
  assert.equal(attempts, 3);

  providerType = 'text/event-stream';
  providerText = sse;
  const budgeted = inbound({ streamBudget: { ...budget, cfg: { ...budget.cfg, maxOutputUnits: 1 } } });
  assert.equal(budgeted.headers.get('x-aig-contract-version'), '6');
  const overBudget = await handleInferenceCenterRequest(budgeted, env);
  assert.equal(overBudget.status, 502);
  assert.equal(overBudget.headers.get('x-aig-result'), 'dispatched');
  assert.equal(overBudget.headers.get('x-aig-error-kind'), 'center_conversion_budget_exceeded');
  assert.equal(attempts, 4);

  const invalidBudget = inbound({ streamBudget: budget });
  invalidBudget.headers.set('x-aig-stream-budget', JSON.stringify({ ...budget, cfg: { ...budget.cfg, maxOutputUnits: 0 } }));
  assert.equal((await handleInferenceCenterRequest(invalidBudget, env)).status, 400);
  const invalidBufferedDeadline = inbound();
  invalidBufferedDeadline.headers.set(
    'x-aig-buffered-response-deadline-ms',
    String(Number(invalidBufferedDeadline.headers.get('x-aig-deadline-ms')) + 1),
  );
  assert.equal((await handleInferenceCenterRequest(invalidBufferedDeadline, env)).status, 400);
  assert.equal(attempts, 4);

  providerText = 'data: {"foo":"bar"}\n\n';
  const interrupted = await handleInferenceCenterRequest(inbound(), env);
  assert.equal(interrupted.status, 502);
  assert.equal(interrupted.headers.get('x-aig-error-kind'), 'center_conversion_invalid');
  assert.equal(attempts, 5);

  globalThis.fetch = async () => {
    attempts++;
    const ongoing = {
      id: 'cmpl-timeout',
      object: 'chat.completion.chunk',
      model: 'gpt-test-upstream',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'still generating' }, finish_reason: null }],
    };
    return new Response(
      new ReadableStream({
        start: (controller) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ongoing)}\n\n`)),
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const shortWindow = Date.now() + 5_000;
  const bufferedTimeout = await handleInferenceCenterRequest(
    inbound({
      deadlineMs: shortWindow,
      upstreamHeadersDeadlineMs: Date.now() + 3_000,
      bufferedResponseDeadlineMs: Date.now() + 250,
    }),
    env,
  );
  assert.equal(
    bufferedTimeout.status,
    504,
    `buffered SSE deadline must be 504, received ${bufferedTimeout.status}; code=${bufferedTimeout.headers.get('x-aig-error-kind')}; result=${bufferedTimeout.headers.get('x-aig-result')}; elapsed-window-ms=${Date.now() - shortWindow + 5_000}`,
  );
  assert.equal(bufferedTimeout.headers.get('x-aig-result'), 'dispatched');
  assert.equal(bufferedTimeout.headers.get('x-aig-error-kind'), 'center_execution_deadline');
  assert.equal(attempts, 6);

  console.log('Inference v6 collects SSE, enforces separated deadlines, translates JSON, isolates raw usage, and fails closed on errors/budgets.');
} finally {
  globalThis.fetch = originalFetch;
}
