#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Deterministic private inference executor tests: no real Provider or Cloudflare.
import assert from 'node:assert/strict';
import { preDispatchProblem } from '../apps/inference/response.ts';
import { loadExecutionConfig, loadGatewayConfig } from '../src/config/nodes.ts';
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
  AIG_TIER2_NODES_01: JSON.stringify([node]),
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ [node.id]: providerSecret }),
};
const validBody = { model: 'chat-test', messages: [{ role: 'user', content: 'Hello' }] };
function request(body = validBody, overrides = {}) {
  const json = JSON.stringify(body);
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
      'x-aig-upstream-headers-deadline-ms': String(Date.now() + 80_000),
      'x-aig-inference-auth': internalKey,
      'content-length': String(new Blob([json]).size),
      ...overrides,
    },
    body: json,
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
  // Only a verified route-unavailable outcome may be marked pre-dispatch.
  const invalidRoute = preDispatchProblem(404, 'center_route_unavailable');
  assert.equal(invalidRoute.headers.get('x-aig-result'), 'skipped');
  assert.equal(invalidRoute.headers.get('x-aig-error-kind'), 'center_route_unavailable');
  assert.equal((await invalidRoute.json()).error.retryable, false);

  // Deployment intent must prevent a silent direct-Provider fallback even if
  // the private Service Binding is absent. No physical attempt is chargeable.
  const unboundEnv = { ...env }; // No binding or activation flag may ever re-enable direct Provider execution.
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
      tier: 'tier-2',
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

  // Gateway regression: an "attempted" Provider fetch is not a proven
  // pre-dispatch refusal. Neither lost upstream headers nor Service Binding
  // rejection may silently replay the request or be called "center unavailable".
  const runCenterGatewayAttempt = async (fetch) => {
    const state = {
      attempted: new Set(),
      attempts: [],
      logicalAttempts: 0,
      dispatches: 0,
      failureKinds: {},
      maxAttempts: 2,
      requestId: unboundState.requestId,
      requestedModel: 'chat-test',
      logger: { info: () => {} },
    };
    const result = await attemptNode({
      request: new Request('https://client.example/v1/chat/completions', { method: 'POST' }),
      env: { ...env, AIG_INFERENCE_SERVICE: { fetch } },
      node: { ...node, tier: 'tier-2', protocol: 'openai', surfaces: ['chat_completions'], baseUrl: node.base_url, credential: providerSecret },
      route: 'openai_chat',
      reqDescriptor: { model: 'chat-test', surface: 'chat_completions', bodyChars: JSON.stringify(validBody).length },
      bodyJson: validBody,
      requestedModel: 'chat-test',
      requestId: state.requestId,
      state,
      policy: { headersTimeoutMs: null },
      limits: getLimits(env),
      remainingDispatchableAttempts: 2,
      failoverBudgetMs: 60_000,
      requestStartMs: Date.now(),
    });
    return { result, state };
  };
  const returnedByCenter = (status, code, disposition) =>
    new Response(null, { status, headers: { 'x-aig-result': disposition, 'x-aig-error-kind': code } });
  // The legacy non-stream dispatcher used the whole logical attempt window
  // for a slow Provider's response headers. Moving fetch into private Inference
  // must not turn that into a second default 15-second timeout.
  const bufferedWindow = await runCenterGatewayAttempt(async (incoming) => {
    const upstreamDeadline = Number(incoming.headers.get('x-aig-upstream-headers-deadline-ms'));
    const attemptDeadline = Number(incoming.headers.get('x-aig-deadline-ms'));
    assert.ok(upstreamDeadline - Date.now() > 30_000, 'buffered Provider header deadline must retain the long attempt window');
    assert.ok(upstreamDeadline <= attemptDeadline, 'center header cutoff must stay within the attempt budget');
    return returnedByCenter(404, 'center_route_unavailable', 'skipped');
  });
  assert.equal(bufferedWindow.result.rotate, true, 'verified pre-dispatch refusal still allows another node');
  for (const [status, code, expectedStatus] of [
    [502, 'center_upstream_network', 502],
    [504, 'center_upstream_headers_timeout', 504],
  ]) {
    let calls = 0;
    const { result, state } = await runCenterGatewayAttempt(async () => {
      calls++;
      return returnedByCenter(status, code, 'attempted');
    });
    assert.equal(calls, 1, 'unknown upstream outcome executes one Service Binding call only');
    assert.equal(result.response?.status, expectedStatus);
    assert.notEqual(result.rotate, true, 'unknown upstream outcome MUST NOT rotate');
    assert.equal(state.logicalAttempts, 1, 'attempted Provider fetch is charged exactly once');
    assert.equal((await result.response.clone().json()).error.details.gateway_code, 'gateway_inference_upstream_outcome_unknown');
  }
  const skipped = await runCenterGatewayAttempt(async () => returnedByCenter(404, 'center_route_unavailable', 'skipped'));
  assert.equal(skipped.result.rotate, true, 'only verified pre-dispatch may rotate');
  assert.equal(skipped.result.budgetCharged, false);
  assert.equal(skipped.state.logicalAttempts, 0);
  const afterDispatch = await runCenterGatewayAttempt(async () => returnedByCenter(504, 'center_execution_deadline', 'dispatched'));
  assert.equal(afterDispatch.result.response?.status, 504);
  assert.notEqual(afterDispatch.result.rotate, true);
  assert.equal((await afterDispatch.result.response.clone().json()).error.details.gateway_code, 'gateway_inference_execution_timeout');
  const bindingFailure = await runCenterGatewayAttempt(async () => {
    throw new Error('Service Binding rejected after possible upstream execution');
  });
  assert.equal(bindingFailure.result.response?.status, 502, 'transport uncertainty is not a verified center configuration outage');
  assert.notEqual(bindingFailure.result.rotate, true);
  assert.equal((await bindingFailure.result.response.clone().json()).error.details.gateway_code, 'gateway_inference_center_transport_error');

  // A center-owned Gateway must be routable with NO static Provider secrets.
  // A public Gateway can route secretless metadata even when a private binding
  // is missing; the dispatch layer must fail closed rather than use Provider keys.
  const secretless = {
    AIG_ACCESS_KEY_AGENT: 'center-metadata-test-client-key',
    AIG_TIER2_NODES_01: env.AIG_TIER2_NODES_01,
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
  assert.equal(loadGatewayConfig(secretless).ready, true, 'public Gateway never requires static Provider credentials');
  assert.equal(loadExecutionConfig(secretless).ready, false, 'private inference must retain credential enforcement');
  const redactedGateway = loadGatewayConfig({
    ...secretless,
    AIG_INFERENCE_ACTIVE: 'true',
    AIG_TIER2_CREDENTIALS_01: env.AIG_TIER2_CREDENTIALS_01,
  });
  assert.equal(redactedGateway.nodes[0].credential, '', 'Gateway must never retain an upstream key for center-owned nodes');
  const staleSecretGateway = loadGatewayConfig({
    ...secretless,
    AIG_INFERENCE_ACTIVE: 'true',
    AIG_TIER2_CREDENTIALS_01: '{invalid-json:',
  });
  assert.equal(staleSecretGateway.ready, true, 'Gateway must ignore obsolete secret values when inference center is active');
  assert.equal(staleSecretGateway.hasConfigErrors, false, 'unused Provider secret values must not affect active Gateway config');
  const forbiddenSecretRead = { ...secretless, AIG_INFERENCE_ACTIVE: 'true' };
  Object.defineProperty(forbiddenSecretRead, 'AIG_TIER2_CREDENTIALS_01', {
    enumerable: true,
    get() {
      throw new Error('Gateway must never read Provider credential shards when a private center is active');
    },
  });
  const noSecretRead = loadGatewayConfig(forbiddenSecretRead);
  assert.equal(noSecretRead.ready, true);
  assert.equal(noSecretRead.nodes[0].credential, '');
  assert.deepEqual(noSecretRead.bindings.secretShards, ['AIG_TIER2_CREDENTIALS_01']);
  assert.equal(
    loadExecutionConfig({ ...secretless, AIG_TIER2_CREDENTIALS_01: '{invalid-json:' }).ready,
    false,
    'private center must continue rejecting malformed credential shards',
  );
  assert.equal(loadExecutionConfig(env).nodes[0].credential, providerSecret, 'private center owns the Provider credential');

  // Size and memory compatibility are a hard prerequisite for removing the
  // Gateway's legacy Provider dispatch. Both sides share the same 20 MiB
  // default ceiling, while each worker isolate has an independent 32 MiB
  // in-flight body budget.
  const MIB = 1024 * 1024;
  assert.equal(getLimits(env).maxBodyBytes, 20 * MIB);
  const providerOk = () =>
    new Response(
      JSON.stringify({
        id: 'cmpl-large',
        object: 'chat.completion',
        model: 'gpt-test-upstream',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  globalThis.fetch = async (_url, options) => {
    attempts++;
    assert.match(String(options.body).slice(0, 80), /"model":"gpt-test-upstream"/);
    return providerOk();
  };
  const acceptedLargeBody = { model: 'chat-test', messages: [{ role: 'user', content: 'a'.repeat(19 * MIB) }] };
  const accepted = await handleInferenceCenterRequest(request(acceptedLargeBody), env);
  assert.equal(accepted.status, 200, 'a 19 MiB Gateway-compatible body must reach the private Provider executor');
  const attemptsAfterLarge = attempts;
  const overLimitBody = { model: 'chat-test', messages: [{ role: 'user', content: 'b'.repeat(21 * MIB) }] };
  assert.equal((await handleInferenceCenterRequest(request(overLimitBody), env)).status, 413, 'a declared 21 MiB body is rejected');
  assert.equal(
    (await handleInferenceCenterRequest(request(overLimitBody, { 'content-length': '12' }), env)).status,
    413,
    'forged small Content-Length must not defeat the bounded streaming body reader',
  );
  assert.equal(
    (await handleInferenceCenterRequest(request(validBody, { 'content-length': '-1' }), env)).status,
    400,
    'an invalid signed private body length is rejected before a Provider call',
  );
  assert.equal(attempts, attemptsAfterLarge, 'oversized or invalid bodies never execute Provider requests');

  // Even if two independent Gateway isolates can each admit a large request,
  // a single private center isolate must not retain both 17 MiB bodies.
  const heldBody = { model: 'chat-test', messages: [{ role: 'user', content: 'c'.repeat(17 * MIB) }] };
  let releaseProvider;
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  let heldCalls = 0;
  globalThis.fetch = async () => {
    attempts++;
    heldCalls++;
    if (heldCalls === 1) {
      notifyStarted();
      await gate;
    }
    return providerOk();
  };
  const first = handleInferenceCenterRequest(request(heldBody), env);
  await started;
  const memoryRefusal = await handleInferenceCenterRequest(request(heldBody), env);
  assert.equal(memoryRefusal.status, 503);
  assert.equal(memoryRefusal.headers.get('retry-after'), '1');
  assert.equal(memoryRefusal.headers.get('x-aig-result'), null, 'admission refusal never claims a physical attempt');
  assert.equal(heldCalls, 1, 'the second request must not reach a Provider');
  releaseProvider();
  assert.equal((await first).status, 200);
  assert.equal((await handleInferenceCenterRequest(request(validBody), env)).status, 200, 'memory budget is refunded after execution');
  assert.equal(heldCalls, 2);
  assert.equal(attempts, attemptsAfterLarge + 2, 'only two admitted requests reach physical execution');

  globalThis.fetch = async (_url, options) => {
    attempts++;
    return new Promise((_, reject) => {
      const abort = () => reject(new Error('provider response headers timed out'));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    });
  };
  const headerTimeout = await handleInferenceCenterRequest(
    request(validBody, { 'x-aig-upstream-headers-deadline-ms': String(Date.now() + 200) }),
    env,
  );
  assert.equal(headerTimeout.status, 504);
  assert.equal(headerTimeout.headers.get('x-aig-result'), 'attempted');
  assert.equal(headerTimeout.headers.get('x-aig-error-kind'), 'center_upstream_headers_timeout');
  assert.equal(attempts, attemptsAfterLarge + 3, 'a Provider header timeout remains an explicit attempted outcome');

  console.log('Private inference center auth, native mapping, network/header-timeout classification and fail-closed contract passed.');
} finally {
  globalThis.fetch = originalFetch;
}
