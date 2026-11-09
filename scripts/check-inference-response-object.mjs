#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Private Center v3: center-owned JSON/SSE translation and failure-closed usage accounting.
import assert from 'node:assert/strict';
import { INFERENCE_TRANSLATED_OBJECT_FORMAT, isTranslatedObjectEnvelope } from '../packages/contracts/execution.ts';
import { handleInferenceCenterRequest } from '../src/inference/inference-center-entry.ts';
import { buildInferenceRequest } from '../src/inference/inference-client-request.ts';

const key = 'local-inference-v3-object-contract-key-32';
const node = {
  id: 'test-native-node',
  provider: 'openai',
  base_url: 'https://provider.invalid/v1',
  models: { 'chat-test': 'gpt-test-upstream' },
};
const env = {
  AIG_INFERENCE_AUTH_KEY: key,
  AIG_TIER2_NODES_01: JSON.stringify([node]),
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ [node.id]: 'test-only-provider-credential' }),
  AIG_INFERENCE_SERVICE: {
    fetch: async () => {
      throw new Error('not called');
    },
  },
};
const body = { model: 'chat-test', max_tokens: 128, messages: [{ role: 'user', content: 'Hello' }] };
const client = new Request('https://gateway.invalid/v1/messages', {
  method: 'POST',
  headers: { authorization: 'Bearer private', cookie: 'secret=value' },
});
function inbound(returnObject = true) {
  return buildInferenceRequest(env, {
    request: client,
    requestId: '12345678-1234-4234-8234-123456789012',
    node: { id: node.id },
    logicalModel: 'chat-test',
    surface: 'chat_completions',
    inputSurface: 'messages',
    preferNonstream: true,
    returnObject: returnObject ? true : undefined,
    deadlineMs: Date.now() + 90_000,
    body: JSON.stringify(body),
  });
}
const upstream = {
  id: 'cmpl-test',
  object: 'chat.completion',
  model: 'gpt-test-upstream',
  choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
};
const originalFetch = globalThis.fetch;
let attempts = 0;
let answer = new Response(JSON.stringify(upstream), { status: 200, headers: { 'content-type': 'application/json' } });
try {
  globalThis.fetch = async (_url, options) => {
    attempts++;
    assert.equal(JSON.parse(options.body).stream, undefined);
    assert.equal(new Headers(options.headers).has('x-aig-return-object'), false);
    return answer.clone();
  };

  const request = inbound();
  assert.equal(request.headers.get('x-aig-contract-version'), '3');
  assert.equal(request.headers.get('x-aig-return-object'), 'true');
  const translated = await handleInferenceCenterRequest(request, env);
  assert.equal(translated.status, 200);
  assert.equal(translated.headers.get('x-aig-result'), 'dispatched');
  assert.equal(translated.headers.get('x-aig-response-format'), INFERENCE_TRANSLATED_OBJECT_FORMAT);
  const envelope = await translated.json();
  assert.equal(isTranslatedObjectEnvelope(envelope), true);
  assert.equal(envelope.kind, INFERENCE_TRANSLATED_OBJECT_FORMAT);
  assert.equal(envelope.response.content[0].text, 'done');
  assert.equal(envelope.response.type, 'message');
  assert.deepEqual(envelope.upstreamUsage, upstream.usage);
  assert.equal(attempts, 1);

  const oldMode = await handleInferenceCenterRequest(inbound(false), env);
  assert.equal(oldMode.headers.has('x-aig-response-format'), false);
  assert.equal((await oldMode.json()).object, 'chat.completion');
  assert.equal(attempts, 2);

  const downgraded = inbound();
  downgraded.headers.set('x-aig-contract-version', '2');
  assert.equal((await handleInferenceCenterRequest(downgraded, env)).status, 400);
  assert.equal(attempts, 2);

  answer = new Response(
    JSON.stringify({ ...upstream, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  const empty = await handleInferenceCenterRequest(inbound(), env);
  assert.equal(empty.status, 502);
  assert.equal(empty.headers.get('x-aig-error-kind'), 'center_converted_object_invalid');
  assert.equal(empty.headers.has('x-aig-response-format'), false);
  assert.equal(attempts, 3);

  // A Provider may stream despite the v3 prefer-nonstream flag. The center
  // must collect it into a tagged client object rather than leaking raw SSE.
  const chunks = [
    {
      id: 'cmpl-test',
      object: 'chat.completion.chunk',
      model: 'gpt-test-upstream',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'streamed' }, finish_reason: null }],
    },
    { id: 'cmpl-test', object: 'chat.completion.chunk', model: 'gpt-test-upstream', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { id: 'cmpl-test', object: 'chat.completion.chunk', model: 'gpt-test-upstream', choices: [], usage: upstream.usage },
  ];
  answer = new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  const streamed = await handleInferenceCenterRequest(inbound(), env);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get('x-aig-response-format'), INFERENCE_TRANSLATED_OBJECT_FORMAT);
  const streamedObject = await streamed.json();
  assert.equal(isTranslatedObjectEnvelope(streamedObject), true);
  assert.equal(streamedObject.response.content[0].text, 'streamed');
  assert.deepEqual(streamedObject.upstreamUsage, upstream.usage);
  assert.equal(attempts, 4);

  answer = new Response('{malformed-json', { status: 200, headers: { 'content-type': 'application/json' } });
  const malformed = await handleInferenceCenterRequest(inbound(), env);
  assert.equal(malformed.status, 502);
  assert.equal(malformed.headers.get('x-aig-error-kind'), 'center_converted_object_invalid');
  assert.equal(attempts, 5);

  assert.equal(isTranslatedObjectEnvelope({ kind: INFERENCE_TRANSLATED_OBJECT_FORMAT, response: [], upstreamUsage: null }), false);
  assert.equal(isTranslatedObjectEnvelope({ kind: INFERENCE_TRANSLATED_OBJECT_FORMAT, response: {} }), false);
  console.log('Inference v3 translates native objects and unexpected SSE in-center, preserves physical usage and fails closed on invalid output.');
} finally {
  globalThis.fetch = originalFetch;
}
