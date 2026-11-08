#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Deterministic private inference executor tests: no real Provider or Cloudflare.
import assert from 'node:assert/strict';
import { getLimits } from '../src/config/timeouts.ts';
import { handleInferenceCenterRequest } from '../src/inference/inference-center-entry.ts';
import { attemptNode } from '../src/request/attempt/dispatch.ts';

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

  // Deployment intent must prevent a silent direct-Provider fallback even if
  // the private Service Binding is absent. No physical attempt is chargeable.
  const unboundEnv = { ...env, AIG_INFERENCE_ACTIVE: 'true' };
  const unboundState = {
    attempted: new Set(),
    attempts: [],
    logicalAttempts: 0,
    dispatches: 0,
    failureKinds: {},
    maxAttempts: 2,
    requestId: '12345678-1234-4234-8234-123456789012',
    requestedModel: 'chat-test',
    logger: { info: () => {} },
  };
  const unboundAttempt = await attemptNode({
    request: new Request('https://client.example/v1/chat/completions', { method: 'POST' }),
    env: unboundEnv,
    node: {
      ...node,
      tier: 'tier-3',
      protocol: 'openai',
      surfaces: ['chat_completions'],
      baseUrl: node.base_url,
      credential: providerSecret,
    },
    route: 'openai_chat',
    reqDescriptor: {
      model: 'chat-test',
      surface: 'chat_completions',
      bodyChars: JSON.stringify(validBody).length,
    },
    bodyJson: validBody,
    requestedModel: 'chat-test',
    requestId: unboundState.requestId,
    state: unboundState,
    policy: { headersTimeoutMs: null },
    limits: getLimits(unboundEnv),
    remainingDispatchableAttempts: 1,
    failoverBudgetMs: 60_000,
    requestStartMs: Date.now(),
  });
  assert.equal(unboundAttempt.response?.status, 503);
  assert.equal(unboundAttempt.budgetCharged, false);
  assert.equal(unboundState.logicalAttempts, 0);
  assert.equal(unboundState.dispatches, 0);
  assert.equal(attempts, 2, 'missing private inference binding must not call any Provider');
  console.log('Private inference center auth, native mapping, network classification and fail-closed contract passed.');
} finally {
  globalThis.fetch = originalFetch;
}
