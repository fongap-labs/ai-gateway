#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Deterministic private inference executor tests: no real Provider or Cloudflare.
import assert from 'node:assert/strict';
import { handleInferenceCenterRequest } from '../src/inference/inference-center-entry.ts';

const internalKey = 'local-inference-center-contract-test-key-32';
const providerSecret = 'test-provider-credential-not-a-real-key';
const node = {
  id: 'test-native-node',
  provider: 'openai',
  base_url: 'https://provider.invalid/v1',
  models: { 'chat-test': 'gpt-test-upstream' },
};
const env = {
  AIG_INFERENCE_AUTH_KEY: internalKey,
  AIG_TIER3_NODES_01: JSON.stringify([node]),
  AIG_TIER3_CREDENTIALS_01: JSON.stringify({ [node.id]: providerSecret }),
};
const validBody = { model: 'chat-test', messages: [{ role: 'user', content: 'Hello' }] };
function request(body = validBody, overrides = {}) {
  return new Request('https://inference.internal/internal/execute', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aig-contract-version': '1',
      'x-aig-request-id': '12345678-1234-4234-8234-123456789012',
      'x-aig-node-id': node.id,
      'x-aig-model': 'chat-test',
      'x-aig-surface': 'chat_completions',
      'x-aig-deadline-ms': String(Date.now() + 90_000),
      'x-aig-inference-auth': internalKey,
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}
const originalFetch = globalThis.fetch;
let attempts = 0;
try {
  globalThis.fetch = async (url, opts) => {
    attempts++;
    assert.ok(String(url).endsWith('/chat/completions'), 'the selected native route is respected');
    const headers = new Headers(opts.headers);
    assert.equal(headers.get('authorization'), `Bearer ${providerSecret}`);
    assert.equal(headers.has('cookie'), false);
    assert.equal(headers.has('x-aig-inference-auth'), false);
    assert.equal(headers.has('x-api-key'), false);
    assert.equal(JSON.parse(opts.body).model, 'gpt-test-upstream');
    return new Response(
      JSON.stringify({
        id: 'cmpl-test',
        object: 'chat.completion',
        model: 'gpt-test-upstream',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  assert.equal((await handleInferenceCenterRequest(request(), { ...env, AIG_INFERENCE_AUTH_KEY: undefined })).status, 403);
  assert.equal((await handleInferenceCenterRequest(request(validBody, { 'x-aig-surface': 'images_generations' }), env)).status, 400);
  assert.equal((await handleInferenceCenterRequest(request(validBody, { 'x-aig-node-id': 'missing-node' }), env)).status, 404);
  assert.equal((await handleInferenceCenterRequest(request({ ...validBody, model: 'other' }), env)).status, 400);
  assert.equal(attempts, 0);

  const forged = request(validBody, { authorization: 'Bearer attacker', cookie: 'session=attacker', 'x-api-key': 'attacker' });
  const ok = await handleInferenceCenterRequest(forged, env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-aig-result'), 'dispatched');
  assert.equal((await ok.json()).model, 'gpt-test-upstream');
  assert.equal(attempts, 1);

  globalThis.fetch = async () => {
    attempts++;
    throw new Error('test-only provider network failure');
  };
  const failed = await handleInferenceCenterRequest(request(), env);
  assert.equal(failed.status, 502);
  assert.equal(failed.headers.get('x-aig-result'), 'attempted');
  assert.equal(failed.headers.get('x-aig-error-kind'), 'center_upstream_network');
  assert.equal(attempts, 2, 'center executes one physical attempt and never retries');
  console.log('Private inference center auth, native mapping, network classification and single-attempt contract passed.');
} finally {
  globalThis.fetch = originalFetch;
}
