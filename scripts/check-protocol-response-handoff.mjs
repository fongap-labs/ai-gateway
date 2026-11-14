#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// v8 Protocol owns response translation; Inference owns exactly one physical attempt.
import assert from 'node:assert/strict';
import { invokeInferenceNode } from '../apps/gateway/transport/inference-client-request.ts';
import { decodeFramedInferenceResponse } from '../apps/gateway/transport/inference-stream-client.ts';
import { handleInferenceCenterRequest } from '../apps/inference/index.ts';
import { handleProtocolCenterRequest } from '../apps/protocol/index.ts';
import {
  buildExecutionHeaders,
  INFERENCE_TRANSLATED_OBJECT_FORMAT,
  isTranslatedObjectEnvelope,
  parseExecutionInvocation,
} from '../packages/contracts/execution.ts';
import { INFERENCE_FRAMED_STREAM_CONTENT_TYPE, INFERENCE_FRAMED_STREAM_FORMAT } from '../packages/contracts/inference-stream-frames.ts';

const protocolKey = 'test-only-v8-protocol-private-auth-key-32';
const inferenceKey = 'test-only-v8-inference-private-auth-key-32';
const requestId = '12345678-1234-4234-8234-123456789012';
const node = {
  id: 'test-native-node',
  provider: 'openai',
  base_url: 'https://provider.invalid/v1',
  models: { 'chat-test': 'gpt-test-upstream' },
};
const original = { model: 'chat-test', max_tokens: 128, messages: [{ role: 'user', content: 'Hello' }] };
const client = new Request('https://gateway.invalid/v1/messages', {
  method: 'POST',
  headers: { authorization: 'Bearer private-client', cookie: 'secret=value', 'x-api-key': 'private-client' },
});
const usage = { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, private_tag: 'upstream-usage-only' };
const nativeObject = {
  id: 'cmpl-test',
  object: 'chat.completion',
  model: 'gpt-test-upstream',
  choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  usage,
};
const chunks = [
  {
    id: 'cmpl-test',
    object: 'chat.completion.chunk',
    model: 'gpt-test-upstream',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'streamed' }, finish_reason: null }],
  },
  {
    id: 'cmpl-test',
    object: 'chat.completion.chunk',
    model: 'gpt-test-upstream',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
  { id: 'cmpl-test', object: 'chat.completion.chunk', model: 'gpt-test-upstream', choices: [], usage },
];
const providerSse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
const env = {
  AIG_PROTOCOL_AUTH_KEY: protocolKey,
  AIG_INFERENCE_AUTH_KEY: inferenceKey,
  AIG_TIER2_NODES_01: JSON.stringify([node]),
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ [node.id]: 'test-only-provider-credential' }),
};
let protocolCalls = 0;
let inferenceCalls = 0;
let providerCalls = 0;
let mode = 'object';
env.AIG_PROTOCOL_SERVICE = {
  fetch(request) {
    protocolCalls++;
    assert.equal(request.headers.get('x-aig-protocol-auth'), protocolKey);
    assert.equal(request.headers.has('x-aig-inference-auth'), false);
    return handleProtocolCenterRequest(request, env);
  },
};
env.AIG_INFERENCE_SERVICE = {
  async fetch(request) {
    inferenceCalls++;
    assert.equal(request.headers.get('x-aig-inference-auth'), inferenceKey);
    assert.equal(request.headers.has('x-aig-protocol-auth'), false);
    const ticket = parseExecutionInvocation(request, new Set(['chat_completions', 'responses', 'messages']));
    assert.ok(ticket);
    if (ticket.inputSurface) {
      assert.equal(ticket.preparedRequest, true);
      assert.equal(ticket.rawResponse, true);
      assert.equal(request.headers.get('x-aig-contract-version'), '8');
    }
    const response = await handleInferenceCenterRequest(request, env);
    if (ticket.rawResponse && response.ok) {
      assert.equal(response.headers.get('x-aig-response-format'), null, 'Inference must never pre-translate a v8 result');
      assert.equal(response.headers.get('x-aig-result'), 'dispatched');
    }
    return response;
  },
};
function invocation(overrides = {}) {
  return {
    request: client,
    requestId,
    node: { id: node.id },
    logicalModel: 'chat-test',
    surface: 'chat_completions',
    inputSurface: 'messages',
    body: JSON.stringify(original),
    deadlineMs: Date.now() + 90_000,
    ...overrides,
  };
}
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (_url, opts) => {
    providerCalls++;
    const headers = new Headers(opts.headers);
    assert.equal(headers.has('x-aig-inference-auth'), false);
    assert.equal(headers.has('x-aig-protocol-auth'), false);
    assert.equal(headers.has('authorization'), true);
    const physical = JSON.parse(opts.body);
    assert.equal(physical.model, 'gpt-test-upstream');
    if (mode === 'http429') {
      return new Response('{"error":{"message":"busy"}}', { status: 429, headers: { 'content-type': 'application/json' } });
    }
    if (mode === 'bad-json') {
      return new Response('{invalid', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (mode === 'sse') {
      return new Response(providerSse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(nativeObject), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  mode = 'object';
  const translated = await invokeInferenceNode(env, invocation({ returnObject: true, preferNonstream: true }));
  assert.equal(translated.status, 200);
  assert.equal(translated.headers.get('x-aig-response-format'), INFERENCE_TRANSLATED_OBJECT_FORMAT);
  const envelope = await translated.json();
  assert.ok(isTranslatedObjectEnvelope(envelope));
  assert.equal(envelope.response.content[0].text, 'done');
  assert.deepEqual(envelope.upstreamUsage, usage);
  assert.equal(providerCalls, 1);

  mode = 'sse';
  const streamed = await invokeInferenceNode(
    env,
    invocation({ body: JSON.stringify({ ...original, stream: true }), returnStream: true, displayModel: 'chat-test' }),
  );
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get('content-type'), INFERENCE_FRAMED_STREAM_CONTENT_TYPE);
  assert.equal(streamed.headers.get('x-aig-response-format'), INFERENCE_FRAMED_STREAM_FORMAT);
  const rawUsage = [];
  const publicStream = decodeFramedInferenceResponse(streamed, { onUsage: (value) => rawUsage.push(value) });
  const publicBody = await new Response(publicStream).text();
  assert.match(publicBody, /streamed/);
  assert.match(publicBody, /message_stop/);
  assert.doesNotMatch(publicBody, /private_tag|upstream-usage-only/);
  assert.deepEqual(rawUsage, [usage], 'physical usage must survive one private frame and never enter client bytes');
  assert.equal(providerCalls, 2);

  mode = 'sse';
  const collected = await invokeInferenceNode(env, invocation({ returnObject: true }));
  assert.equal(collected.status, 200);
  assert.equal(collected.headers.get('x-aig-response-format'), INFERENCE_TRANSLATED_OBJECT_FORMAT);
  const collectedBody = await collected.json();
  assert.equal(collectedBody.response.content[0].text, 'streamed');
  assert.deepEqual(collectedBody.upstreamUsage, usage);
  assert.equal(providerCalls, 3);

  mode = 'http429';
  const limited = await invokeInferenceNode(env, invocation({ returnObject: true, preferNonstream: true }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('x-aig-result'), 'dispatched');
  assert.equal(limited.headers.has('x-aig-response-format'), false);
  assert.equal(providerCalls, 4, 'HTTP errors remain one physical attempt');

  mode = 'bad-json';
  const invalid = await invokeInferenceNode(env, invocation({ returnObject: true, preferNonstream: true }));
  assert.equal(invalid.status, 502);
  assert.equal(invalid.headers.get('x-aig-result'), 'dispatched', 'invalid object must not be marked pre-dispatch');
  assert.equal(invalid.headers.has('x-aig-response-format'), false);
  assert.equal(providerCalls, 5);

  const native = await invokeInferenceNode(env, invocation({ inputSurface: undefined, returnObject: undefined }));
  assert.equal(native.status, 200);
  assert.equal(protocolCalls, 5, 'native model route must bypass Protocol');
  assert.equal(inferenceCalls, 6);
  assert.equal(providerCalls, 6);

  const baseTicket = {
    requestId,
    nodeId: node.id,
    logicalModel: 'chat-test',
    surface: 'chat_completions',
    inputSurface: 'messages',
    deadlineMs: Date.now() + 90_000,
    preparedRequest: true,
    rawResponse: true,
  };
  const headers = buildExecutionHeaders(baseTicket, 'x-aig-inference-auth', inferenceKey);
  assert.equal(headers.get('x-aig-contract-version'), '8');
  const ticket = new Request('https://inference.internal/internal/execute', {
    method: 'POST',
    headers,
    body: JSON.stringify(original),
  });
  assert.equal(parseExecutionInvocation(ticket, new Set(['chat_completions']))?.rawResponse, true);
  ticket.headers.delete('x-aig-raw-response');
  assert.equal(parseExecutionInvocation(ticket, new Set(['chat_completions'])), null, 'v8 must require its exact raw marker');
  ticket.headers.set('x-aig-raw-response', 'true');
  ticket.headers.delete('x-aig-prepared-request');
  assert.equal(parseExecutionInvocation(ticket, new Set(['chat_completions'])), null, 'v8 must require prior conversion marker');

  assert.equal(protocolCalls, 5);
  assert.equal(inferenceCalls, 6);
  console.log('Protocol v8: object + SSE + collected object, upstream usage, native bypass, errors, exact headers, one attempt passed.');
} finally {
  globalThis.fetch = originalFetch;
}
