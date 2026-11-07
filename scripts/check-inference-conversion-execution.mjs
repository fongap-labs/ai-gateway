#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Cross-protocol physical requests run inside the private Inference Center.
import assert from 'node:assert/strict';
import { buildInferenceRequest } from '../src/inference/inference-client-request.ts';
import { handleInferenceCenterRequest } from '../src/inference/inference-center-entry.ts';

const key = 'local-inference-cross-protocol-contract-key-32';
const node = {
  id: 'test-native-node',
  provider: 'openai',
  base_url: 'https://provider.invalid/v1',
  models: { 'chat-test': 'gpt-test-upstream' },
};
const env = {
  AIG_INFERENCE_AUTH_KEY: key,
  AIG_TIER3_NODES_01: JSON.stringify([node]),
  AIG_TIER3_CREDENTIALS_01: JSON.stringify({ [node.id]: 'test-only-provider-credential' }),
  AIG_INFERENCE_SERVICE: {
    fetch: async () => {
      throw new Error('test must not invoke a Service Binding');
    },
  },
};
const message = { model: 'chat-test', max_tokens: 128, messages: [{ role: 'user', content: 'Hello' }] };
const clientRequest = new Request('https://gateway.invalid/v1/messages', {
  method: 'POST',
  headers: { authorization: 'Bearer client-secret', cookie: 'private=value', 'x-api-key': 'client-secret' },
});
function inbound(body = message, inputSurface = 'messages', preferNonstream = undefined) {
  return buildInferenceRequest(env, {
    request: clientRequest,
    requestId: '12345678-1234-4234-8234-123456789012',
    node: { id: node.id },
    logicalModel: 'chat-test',
    surface: 'chat_completions',
    inputSurface,
    preferNonstream,
    deadlineMs: Date.now() + 90_000,
    body: JSON.stringify(body),
  });
}

const initial = inbound();
assert.equal(initial.headers.get('x-aig-input-surface'), 'messages');
assert.equal(initial.headers.has('authorization'), false);
assert.equal(initial.headers.has('cookie'), false);
assert.equal(initial.headers.has('x-api-key'), false);
assert.equal(initial.headers.get('x-aig-conversion-prefer-nonstream'), null);

const originalFetch = globalThis.fetch;
const executed = [];
try {
  globalThis.fetch = async (url, options) => {
    const content = JSON.parse(options.body);
    executed.push({ url: String(url), content, headers: new Headers(options.headers) });
    return new Response(
      JSON.stringify({
        id: 'cmpl-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const converted = await handleInferenceCenterRequest(initial, env);
  assert.equal(converted.status, 200);
  assert.equal(converted.headers.get('x-aig-result'), 'dispatched');
  assert.equal(executed.length, 1);
  assert.ok(executed[0].url.endsWith('/chat/completions'));
  assert.equal(executed[0].content.model, 'gpt-test-upstream');
  assert.equal(executed[0].content.stream, true);
  assert.deepEqual(executed[0].content.messages, [{ role: 'user', content: 'Hello' }]);
  assert.equal(executed[0].headers.has('x-aig-input-surface'), false);
  assert.equal(executed[0].headers.has('x-aig-inference-auth'), false);

  const preferred = await handleInferenceCenterRequest(inbound(message, 'messages', true), env);
  assert.equal(preferred.status, 200);
  assert.equal(executed.length, 2);
  assert.notEqual(executed[1].content.stream, true, 'explicit non-streaming preference must survive conversion');

  const invalid = await handleInferenceCenterRequest(inbound({ ...message, unknown_field: true }), env);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'center_conversion_invalid');
  assert.equal(executed.length, 2, 'invalid translation must not dispatch a Provider attempt');

  const spoofed = inbound();
  spoofed.headers.set('x-aig-input-surface', 'chat_completions');
  assert.equal((await handleInferenceCenterRequest(spoofed, env)).status, 400);
  assert.equal(executed.length, 2, 'same-protocol spoof must not contact Provider');

  const fakePreference = inbound();
  fakePreference.headers.set('x-aig-conversion-prefer-nonstream', 'false');
  assert.equal((await handleInferenceCenterRequest(fakePreference, env)).status, 400);
  assert.equal(executed.length, 2, 'invalid preference must fail at ticket validation');
  console.log('Inference center executes cross-protocol conversion with validated metadata and no leaked credentials.');
} finally {
  globalThis.fetch = originalFetch;
}
