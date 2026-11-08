#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// v5: cross-center budget enforcement and exactly one private stop reason.
import assert from 'node:assert/strict';
import { handleInferenceCenterRequest } from '../src/inference/inference-center-entry.ts';
import { buildInferenceRequest } from '../src/inference/inference-client-request.ts';
import { decodeFramedInferenceResponse } from '../src/inference/inference-stream-client.ts';

const key = 'integration-v5-budget-key-minimum-thirty-two';
const node = {
  id: 'test-budget-node',
  provider: 'openai',
  base_url: 'https://provider.invalid/v1',
  models: { 'chat-test': 'physical-chat-test' },
};
const env = {
  // Contract construction requires a configured private transport even when
  // the test invokes the center entrypoint directly (no network call).
  AIG_INFERENCE_SERVICE: {
    fetch: async () => {
      throw new Error('unexpected inference transport call');
    },
  },
  AIG_INFERENCE_AUTH_KEY: key,
  AIG_TIER3_NODES_01: JSON.stringify([node]),
  AIG_TIER3_CREDENTIALS_01: JSON.stringify({ [node.id]: 'fake-only-credential' }),
};
const client = new Request('https://gateway.invalid/v1/messages', { method: 'POST' });
const body = { model: 'chat-test', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'Hi' }] };
const cfg = { maxEvents: 100, maxOutputUnits: 3, maxToolEvents: 40, maxToolArgUnits: 256, maxOutputTokens: 0 };
function inbound(mode = 'error') {
  return buildInferenceRequest(env, {
    request: client,
    requestId: '12345678-1234-4234-8234-123456789012',
    node: { id: node.id },
    logicalModel: 'chat-test',
    surface: 'chat_completions',
    inputSurface: 'messages',
    returnStream: true,
    streamBudget: { mode, cfg },
    displayModel: 'public-chat-test',
    deadlineMs: Date.now() + 60_000,
    body: JSON.stringify(body),
  });
}
const encoder = new TextEncoder();
function providerStream() {
  const parts = [
    {
      id: 'cmpl-v5',
      object: 'chat.completion.chunk',
      model: 'physical-chat-test',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello over budget' }, finish_reason: null }],
    },
    {
      id: 'cmpl-v5',
      object: 'chat.completion.chunk',
      model: 'physical-chat-test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
  const lines = parts.map((part) => `data: ${JSON.stringify(part)}\n\n`);
  lines.push('data: [DONE]\n\n');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join('')));
      controller.close();
    },
  });
}

const originalFetch = globalThis.fetch;
let dispatched = 0;
try {
  globalThis.fetch = async (_url, init) => {
    dispatched++;
    const sent = JSON.parse(init.body);
    assert.equal(sent.stream, true);
    assert.equal(sent.model, 'physical-chat-test');
    return new Response(providerStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const request = inbound();
  assert.equal(request.headers.get('x-aig-contract-version'), '5');
  const center = await handleInferenceCenterRequest(request, env);
  assert.equal(center.status, 200);
  const reasons = [];
  const decoded = decodeFramedInferenceResponse(center, { onBudgetStop: (reason) => reasons.push(reason) });
  const clientSse = await new Response(decoded).text();
  assert.deepEqual(reasons, ['output_units']);
  assert.match(clientSse, /conversion_budget_exceeded/);
  assert.doesNotMatch(clientSse, /Hello over budget/);
  assert.equal(dispatched, 1);

  const truncated = await handleInferenceCenterRequest(inbound('truncate'), env);
  assert.equal(truncated.status, 200);
  const truncatedStops = [];
  const shortened = await new Response(decodeFramedInferenceResponse(truncated, { onBudgetStop: (reason) => truncatedStops.push(reason) })).text();
  assert.deepEqual(truncatedStops, ['output_units']);
  assert.match(shortened, /message_stop/);
  assert.doesNotMatch(shortened, /conversion_budget_exceeded|Hello over budget/);
  assert.equal(dispatched, 2);

  const tampered = inbound();
  tampered.headers.set('x-aig-stream-budget', JSON.stringify({ mode: 'error', cfg: { ...cfg, maxOutputUnits: -1 } }));
  assert.equal((await handleInferenceCenterRequest(tampered, env)).status, 400);
  const downgraded = inbound();
  downgraded.headers.set('x-aig-contract-version', '4');
  assert.equal((await handleInferenceCenterRequest(downgraded, env)).status, 400);
  const missingBudget = inbound();
  missingBudget.headers.delete('x-aig-stream-budget');
  assert.equal((await handleInferenceCenterRequest(missingBudget, env)).status, 400);
  assert.equal(dispatched, 2, 'malformed v5 tickets must never dispatch Provider fetch');
  console.log('v5: center enforces output budgets, emits private stops, preserves modes and rejects downgrade.');
} finally {
  globalThis.fetch = originalFetch;
}
