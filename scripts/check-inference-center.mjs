#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Deterministic private inference executor tests: no real Provider or Cloudflare.
import assert from 'node:assert/strict';
import { loadExecutionConfig, loadGatewayConfig } from '../src/config/nodes.ts';
import { getLimits } from '../src/config/timeouts.ts';
import { preDispatchProblem } from '../apps/inference/response.ts';
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
  // Pre-dispatch OAuth skips must be explicit; ordinary center problems never
  // acquire a 'skipped' marker or become eligible for Gateway rotation.
  const missingSubscription = preDispatchProblem(503, 'center_subscription_unavailable');
  assert.equal(missingSubscription.headers.get('x-aig-result'), 'skipped');
  assert.equal(missingSubscription.headers.get('x-aig-error-kind'), 'center_subscription_unavailable');
  assert.equal((await missingSubscription.json()).error.retryable, false);


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

  // A center-owned Gateway must be routable with NO static Provider secrets.
  // An unbound legacy Gateway and private execution center still reject that
  // same secretless static node, preventing credential-free Provider fetches.
  const secretless = {
    AIG_ACCESS_KEY_AGENT: 'center-metadata-test-client-key',
    AIG_TIER3_NODES_01: env.AIG_TIER3_NODES_01,
  };
  const activeGateway = loadGatewayConfig({ ...secretless, AIG_INFERENCE_ACTIVE: 'true' });
  assert.equal(activeGateway.ready, true);
  assert.equal(activeGateway.nodes.length, 1);
  assert.equal(activeGateway.nodes[0].credential, '');
  const boundGateway = loadGatewayConfig({
    ...secretless,
    AIG_INFERENCE_SERVICE: { fetch: async () => new Response(null, { status: 503 }) },
  });
  assert.equal(boundGateway.ready, true);
  assert.equal(boundGateway.nodes[0].credential, '');
  assert.equal(loadGatewayConfig(secretless).ready, false, 'legacy inference requires a real Provider key');
  assert.equal(loadExecutionConfig(secretless).ready, false, 'private inference must retain credential enforcement');
  const redactedGateway = loadGatewayConfig({
    ...secretless,
    AIG_INFERENCE_ACTIVE: 'true',
    AIG_TIER3_CREDENTIALS_01: env.AIG_TIER3_CREDENTIALS_01,
  });
  assert.equal(redactedGateway.nodes[0].credential, '', 'Gateway must never retain an upstream key for center-owned nodes');
  const staleSecretGateway = loadGatewayConfig({
    ...secretless,
    AIG_INFERENCE_ACTIVE: 'true',
    AIG_TIER3_CREDENTIALS_01: '{invalid-json:',
  });
  assert.equal(staleSecretGateway.ready, true, 'Gateway must ignore obsolete secret values when inference center is active');
  assert.equal(staleSecretGateway.hasConfigErrors, false, 'unused Provider secret values must not affect active Gateway config');
  const forbiddenSecretRead = { ...secretless, AIG_INFERENCE_ACTIVE: 'true' };
  Object.defineProperty(forbiddenSecretRead, 'AIG_TIER3_CREDENTIALS_01', {
    enumerable: true,
    get() {
      throw new Error('Gateway must never read Provider credential shards when a private center is active');
    },
  });
  const noSecretRead = loadGatewayConfig(forbiddenSecretRead);
  assert.equal(noSecretRead.ready, true);
  assert.equal(noSecretRead.nodes[0].credential, '');
  assert.deepEqual(noSecretRead.bindings.secretShards, ['AIG_TIER3_CREDENTIALS_01']);
  assert.equal(
    loadExecutionConfig({ ...secretless, AIG_TIER3_CREDENTIALS_01: '{invalid-json:' }).ready,
    false,
    'private center must continue rejecting malformed credential shards',
  );
  assert.equal(loadExecutionConfig(env).nodes[0].credential, providerSecret, 'private center owns the Provider credential');

  console.log('Private inference center auth, native mapping, network classification and fail-closed contract passed.');
} finally {
  globalThis.fetch = originalFetch;
}
