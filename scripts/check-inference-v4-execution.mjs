#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real v4 center conversion: private SSE, physical usage and upgrade safety.
import assert from 'node:assert/strict';
import { INFERENCE_FRAMED_STREAM_FORMAT } from '../packages/contracts/inference-stream-frames.ts';
import { handleInferenceCenterRequest } from '../src/inference/inference-center-entry.ts';
import { buildInferenceRequest } from '../src/inference/inference-client-request.ts';
import { decodeFramedInferenceResponse } from '../src/inference/inference-stream-client.ts';

const key = 'integration-v4-test-center-key-at-least-32-characters';
const node = {
  id: 'test-v4-node',
  provider: 'openai',
  base_url: 'https://provider.invalid/v1',
  models: { 'chat-test': 'gpt-test-upstream' },
};
const env = {
  AIG_INFERENCE_AUTH_KEY: key,
  AIG_INFERENCE_SERVICE: {
    fetch: async () => {
      throw new Error('Service Binding transport is not invoked in this center test');
    },
  },
  AIG_TIER2_NODES_01: JSON.stringify([node]),
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ [node.id]: 'test-credential-no-real-access' }),
};
const client = new Request('https://gateway.invalid/v1/messages', {
  method: 'POST',
  headers: { authorization: 'Bearer end-user-secret', cookie: 'private=yes' },
});
const clientBody = { model: 'chat-test', max_tokens: 128, stream: true, messages: [{ role: 'user', content: 'Hello' }] };
function inbound(overrides = {}) {
  return buildInferenceRequest(env, {
    request: client,
    requestId: '12345678-1234-4234-8234-123456789012',
    node: { id: node.id },
    logicalModel: 'chat-test',
    surface: 'chat_completions',
    inputSurface: 'messages',
    returnStream: true,
    displayModel: 'public-model',
    deadlineMs: Date.now() + 90_000,
    body: JSON.stringify(clientBody),
    ...overrides,
  });
}
const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, physical_only: 'never-expose' };
const providerEvents = [
  {
    id: 'cmpl-test',
    object: 'chat.completion.chunk',
    model: 'gpt-test-upstream',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
  },
  {
    id: 'cmpl-test',
    object: 'chat.completion.chunk',
    model: 'gpt-test-upstream',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
  { id: 'cmpl-test', object: 'chat.completion.chunk', model: 'gpt-test-upstream', choices: [], usage },
];
const frames = providerEvents.map((part) => `data: ${JSON.stringify(part)}\n\n`);
frames.push('data: [DONE]\n\n');
const upstream = frames.join('');

const originalFetch = globalThis.fetch;
let attempts = 0;
let providerBody = upstream;
let providerContentType = 'text/event-stream';
try {
  globalThis.fetch = async (url, options) => {
    attempts++;
    const sent = JSON.parse(options.body);
    assert.equal(sent.model, 'gpt-test-upstream');
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.messages, [{ role: 'user', content: 'Hello' }]);
    const headers = new Headers(options.headers);
    assert.equal(headers.has('x-aig-return-stream'), false);
    assert.equal(headers.has('x-aig-display-model'), false);
    assert.equal(headers.has('authorization') && headers.get('authorization') === 'Bearer end-user-secret', false);
    assert.ok(String(url).endsWith('/chat/completions'));
    return new Response(providerBody, { status: 200, headers: { 'content-type': providerContentType } });
  };

  const request = inbound();
  assert.equal(request.headers.get('x-aig-contract-version'), '4');
  assert.equal(request.headers.get('x-aig-return-stream'), 'true');
  const center = await handleInferenceCenterRequest(request, env);
  assert.equal(center.status, 200);
  assert.equal(center.headers.get('x-aig-result'), 'dispatched');
  assert.equal(center.headers.get('x-aig-response-format'), INFERENCE_FRAMED_STREAM_FORMAT);
  const observed = [];
  const decoded = decodeFramedInferenceResponse(center, { onUsage: (event) => observed.push(event) });
  const clientSse = await new Response(decoded).text();
  assert.match(clientSse, /hello/);
  assert.match(clientSse, /message_stop/);
  assert.match(clientSse, /public-model/);
  assert.doesNotMatch(clientSse, /physical_only|never-expose/);
  assert.deepEqual(observed, [usage]);
  assert.equal(attempts, 1);

  const downgraded = inbound();
  downgraded.headers.set('x-aig-contract-version', '2');
  assert.equal((await handleInferenceCenterRequest(downgraded, env)).status, 400);
  assert.equal(attempts, 1);

  const missingModel = inbound();
  missingModel.headers.delete('x-aig-display-model');
  assert.equal((await handleInferenceCenterRequest(missingModel, env)).status, 400);
  assert.equal(attempts, 1);

  const nonStream = inbound({ body: JSON.stringify({ ...clientBody, stream: false }) });
  assert.equal((await handleInferenceCenterRequest(nonStream, env)).status, 400);
  assert.equal(attempts, 1);

  providerBody = JSON.stringify({
    id: 'cmpl-test',
    object: 'chat.completion',
    model: 'gpt-test-upstream',
    choices: [{ index: 0, message: { role: 'assistant', content: 'JSON fallback' }, finish_reason: 'stop' }],
    usage,
  });
  providerContentType = 'application/json';
  const jsonFallback = await handleInferenceCenterRequest(inbound(), env);
  assert.equal(jsonFallback.status, 200);
  assert.equal(jsonFallback.headers.get('x-aig-response-format'), INFERENCE_FRAMED_STREAM_FORMAT);
  const fallbackUsage = [];
  const fallbackSse = await new Response(decodeFramedInferenceResponse(jsonFallback, { onUsage: (event) => fallbackUsage.push(event) })).text();
  assert.match(fallbackSse, /JSON fallback/);
  assert.match(fallbackSse, /message_stop/);
  assert.match(fallbackSse, /public-model/);
  assert.doesNotMatch(fallbackSse, /physical_only|never-expose|gpt-test-upstream/);
  assert.deepEqual(fallbackUsage, [usage]);
  assert.equal(attempts, 2);

  providerBody = '{invalid-json';
  const invalidFallback = await handleInferenceCenterRequest(inbound(), env);
  assert.equal(invalidFallback.status, 502);
  assert.equal(invalidFallback.headers.get('x-aig-result'), 'dispatched');
  assert.equal(invalidFallback.headers.get('x-aig-error-kind'), 'center_converted_object_invalid');
  assert.equal(invalidFallback.headers.has('x-aig-response-format'), false);
  assert.equal(attempts, 3);

  console.log('Inference v4: streaming and native JSON fallback are framed in center; usage remains private and failures close.');
} finally {
  globalThis.fetch = originalFetch;
}
