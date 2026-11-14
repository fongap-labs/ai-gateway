#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// One cross-protocol request conversion, one physical Provider dispatch, no key leaks.
import assert from 'node:assert/strict';
import { buildExecutionHeaders, parseExecutionInvocation } from '../packages/contracts/execution.ts';
import { invokeInferenceNode } from '../apps/gateway/transport/inference-client-request.ts';
import { handleInferenceCenterRequest } from '../apps/inference/index.ts';
import { handleProtocolCenterRequest } from '../apps/protocol/index.ts';

const protocolKey = 'test-only-private-protocol-center-auth-32';
const inferenceKey = 'test-only-private-inference-center-auth-32';
const requestId = '12345678-1234-4234-8234-123456789012';
const node = {
  id: 'test-native-node',
  provider: 'openai',
  base_url: 'https://provider.invalid/v1',
  models: { 'chat-test': 'gpt-test-upstream' },
};
const message = { model: 'chat-test', max_tokens: 128, messages: [{ role: 'user', content: 'Hello' }] };
const originalClient = new Request('https://gateway.invalid/v1/messages', {
  method: 'POST',
  headers: {
    authorization: 'Bearer client-secret',
    cookie: 'private=value',
    'x-api-key': 'client-secret',
  },
});
let protocolCalls = 0;
let inferenceCalls = 0;
const seen = [];
const env = {
  AIG_PROTOCOL_AUTH_KEY: protocolKey,
  AIG_INFERENCE_AUTH_KEY: inferenceKey,
  AIG_TIER2_NODES_01: JSON.stringify([node]),
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ [node.id]: 'test-only-provider-credential' }),
};
env.AIG_PROTOCOL_SERVICE = {
  async fetch(request) {
    protocolCalls++;
    assert.equal(request.headers.get('x-aig-protocol-auth'), protocolKey);
    for (const sensitive of ['authorization', 'cookie', 'x-api-key', 'x-aig-inference-auth']) {
      assert.equal(request.headers.has(sensitive), false, sensitive);
    }
    return handleProtocolCenterRequest(request, env);
  },
};
env.AIG_INFERENCE_SERVICE = {
  async fetch(request) {
    inferenceCalls++;
    const ticket = parseExecutionInvocation(request, new Set(['chat_completions', 'responses', 'messages']));
    assert.ok(ticket, 'Inference must validate the versioned ticket');
    if (ticket.inputSurface) {
      assert.equal(ticket.preparedRequest, true, 'Inference must not translate the same request twice');
      assert.equal(request.headers.get('x-aig-contract-version'), '7');
      assert.equal(request.headers.get('x-aig-prepared-request'), 'true');
    }
    assert.equal(request.headers.get('x-aig-inference-auth'), inferenceKey);
    assert.equal(request.headers.has('authorization'), false);
    return handleInferenceCenterRequest(request, env);
  },
};
function invocation(body = message, overrides = {}) {
  return {
    request: originalClient,
    requestId,
    node: { id: node.id },
    logicalModel: 'chat-test',
    surface: 'chat_completions',
    inputSurface: 'messages',
    deadlineMs: Date.now() + 90_000,
    body: JSON.stringify(body),
    ...overrides,
  };
}
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), body: JSON.parse(options.body), headers: new Headers(options.headers) });
    return new Response(
      JSON.stringify({
        id: 'cmpl-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const executed = await invokeInferenceNode(env, invocation());
  assert.equal(executed.status, 200);
  assert.equal(executed.headers.get('x-aig-result'), 'dispatched');
  assert.equal(protocolCalls, 1);
  assert.equal(inferenceCalls, 1);
  assert.equal(seen.length, 1, 'Protocol Center must not perform a second physical Provider attempt');
  assert.equal(seen[0].body.model, 'gpt-test-upstream');
  assert.deepEqual(seen[0].body.messages, [{ role: 'user', content: 'Hello' }]);
  assert.equal(seen[0].body.stream, true);
  assert.equal(seen[0].headers.has('x-aig-protocol-auth'), false);
  assert.equal(seen[0].headers.has('x-aig-inference-auth'), false);
  assert.equal(seen[0].headers.has('cookie'), false);

  const nativeBody = { model: 'chat-test', messages: [{ role: 'user', content: 'native' }] };
  const nativeResult = await invokeInferenceNode(env, invocation(nativeBody, { inputSurface: undefined }));
  assert.equal(nativeResult.status, 200);
  assert.equal(protocolCalls, 1, 'same-protocol request bypasses Protocol Center');
  assert.equal(inferenceCalls, 2);
  assert.equal(seen.length, 2);

  const nativeToolName = 'private-native-tool-must-not-leak';
  const nativeOnly = { ...message, tools: [{ type: 'web_search_20250305', name: nativeToolName }] };
  const loss = await invokeInferenceNode(env, invocation(nativeOnly));
  assert.equal(loss.status, 422);
  assert.equal(loss.headers.get('x-aig-result'), 'not-dispatched');
  assert.equal((await loss.json()).error.code, 'center_conversion_semantic_loss');
  assert.equal(inferenceCalls, 2);
  assert.equal(seen.length, 2, 'semantic-loss rejection must never reach Provider');

  const mixed = {
    ...message,
    tools: [
      { name: 'local_lookup', input_schema: { type: 'object', properties: {} } },
      { type: 'web_search_20250305', name: nativeToolName },
    ],
  };
  const accepted = await invokeInferenceNode(env, invocation(mixed));
  assert.equal(accepted.status, 200);
  assert.equal(seen.length, 3);
  assert.equal(seen[2].body.tools.length, 1);
  assert.equal(seen[2].body.tools[0].function.name, 'local_lookup');
  assert.equal(JSON.stringify(seen[2].body).includes(nativeToolName), false);

  await assert.rejects(
    invokeInferenceNode({ ...env, AIG_PROTOCOL_AUTH_KEY: undefined }, invocation()),
    /Private inference center is not configured/,
  );
  assert.equal(seen.length, 3, 'explicit Protocol binding cannot silently fall back');

  const mode = invocation({ ...message, stream: true }, { returnStream: true, displayModel: 'chat-test' });
  let streamed = 0;
  const streamEnv = {
    ...env,
    AIG_INFERENCE_SERVICE: {
      async fetch(request) {
        streamed++;
        assert.equal(request.headers.get('x-aig-contract-version'), '7');
        const ticket = parseExecutionInvocation(request, new Set(['chat_completions', 'responses', 'messages']));
        assert.equal(ticket?.preparedRequest, true);
        return new Response('framed-stream-data', {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson', 'x-aig-response-format': 'framed-v1' },
        });
      },
    },
  };
  streamEnv.AIG_PROTOCOL_SERVICE = { fetch: (request) => handleProtocolCenterRequest(request, streamEnv) };
  const streamedResult = await invokeInferenceNode(streamEnv, mode);
  assert.equal(streamedResult.status, 200);
  assert.equal(streamed, 1);
  assert.equal(await streamedResult.text(), 'framed-stream-data', 'Protocol must forward the response body without buffering it');

  const preparedHeader = buildExecutionHeaders(
    {
      requestId,
      nodeId: node.id,
      logicalModel: 'chat-test',
      surface: 'chat_completions',
      inputSurface: 'messages',
      deadlineMs: Date.now() + 60_000,
      preparedRequest: true,
    },
    'x-aig-inference-auth',
    inferenceKey,
  );
  const preparedRequest = new Request('https://inference.internal/internal/execute', {
    method: 'POST',
    headers: preparedHeader,
    body: JSON.stringify(message),
  });
  assert.equal(parseExecutionInvocation(preparedRequest, new Set(['chat_completions']))?.preparedRequest, true);
  preparedRequest.headers.delete('x-aig-prepared-request');
  assert.equal(parseExecutionInvocation(preparedRequest, new Set(['chat_completions'])), null, 'v7 requires an exact prepared marker');
  console.log('Protocol execution: one conversion, native bypass, one Provider, semantic safety, framed streaming and v7 contract passed.');
} finally {
  globalThis.fetch = originalFetch;
}
