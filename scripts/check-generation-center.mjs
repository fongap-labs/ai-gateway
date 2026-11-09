#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Deterministic tests. No external network, Cloudflare account or real keys.

import assert from 'node:assert/strict';
import { loadExecutionConfig, loadGatewayConfig } from '../src/config/nodes.ts';
import { handleGenerationCenterRequest } from '../src/generation/generation-center-entry.ts';
import { buildGenerationRequest, GenerationCenterUnavailable } from '../src/generation/generation-client-request.ts';
import { quotaFromCenter } from '../src/reliability/center-quota.ts';
import { attemptNode } from '../src/request/attempt/dispatch.ts';

const internalKey = 'generation-test-auth-key-at-least-32-chars';
const secret = 'fake-provider-credential-for-test-only';
const node = {
  id: 'test-image-node',
  provider: 'google-image',
  base_url: 'https://example.invalid',
  models: { 'image-test': 'gemini-test-image' },
};
const env = {
  AIG_GENERATION_AUTH_KEY: internalKey,
  AIG_TIER2_NODES_01: JSON.stringify([node]),
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ [node.id]: secret }),
};
const validBody = { model: 'image-test', prompt: 'Draw a square', size: '1024x1024' };
function request(body = validBody, overrides = {}) {
  return new Request('https://generation.internal/internal/execute', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aig-contract-version': '1',
      'x-aig-request-id': '12345678-1234-4234-8234-123456789012',
      'x-aig-node-id': node.id,
      'x-aig-model': 'image-test',
      'x-aig-surface': 'images_generations',
      'x-aig-deadline-ms': String(Date.now() + 90_000),
      'x-aig-generation-auth': internalKey,
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}

const originalFetch = globalThis.fetch;
let requests = 0;
try {
  globalThis.fetch = async (url, options) => {
    requests += 1;
    assert.match(String(url), /generateContent$/);
    const headers = new Headers(options.headers);
    assert.equal(headers.get('x-goog-api-key'), secret);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    assert.equal(headers.has('x-aig-generation-auth'), false);
    const body = JSON.parse(options.body);
    assert.equal(body.contents[0].parts[0].text, 'Draw a square');
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const fake = request();
  const missingAuth = await handleGenerationCenterRequest(fake, { ...env, AIG_GENERATION_AUTH_KEY: undefined });
  assert.equal(missingAuth.status, 403);
  assert.equal(requests, 0);
  const invalidSurface = await handleGenerationCenterRequest(request(validBody, { 'x-aig-surface': 'video_generations' }), env);
  assert.equal(invalidSurface.status, 400);
  assert.equal(requests, 0);
  const invalidNode = await handleGenerationCenterRequest(request(validBody, { 'x-aig-node-id': 'missing' }), env);
  assert.equal(invalidNode.status, 404);
  assert.equal(requests, 0);
  const invalidBody = await handleGenerationCenterRequest(request({ ...validBody, n: 2 }), env);
  assert.equal(invalidBody.status, 400);
  assert.equal(requests, 0);
  const forged = request(validBody, { authorization: 'Bearer attacker-token', cookie: 'token=attacker', 'x-api-key': 'attacker' });
  const ok = await handleGenerationCenterRequest(forged, env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-aig-generation-normalized'), 'true');
  assert.equal(ok.headers.get('x-aig-result'), 'dispatched');
  assert.equal(requests, 1);
  assert.deepEqual((await ok.json()).data, [{ b64_json: 'aGVsbG8=' }]);

  // Unknown outcomes are terminal and never internally retried.
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('simulated transport outage');
  };
  const failed = await handleGenerationCenterRequest(request(), env);
  assert.equal(failed.status, 502);
  assert.equal(failed.headers.get('x-aig-result'), 'attempted');
  assert.equal((await failed.json()).error.code, 'generation_outcome_unknown');
  assert.equal(requests, 2);

  // Gateway forwards only its own internal contract, never caller auth.
  const invocation = {
    request: new Request('https://client.example/v1/images/generations', {
      method: 'POST',
      headers: { authorization: 'Bearer client', cookie: 'secret=x', 'x-aig-generation-auth': 'forged' },
    }),
    requestId: '12345678-1234-4234-8234-123456789012',
    node: { id: node.id },
    logicalModel: 'image-test',
    deadlineMs: Date.now() + 60_000,
    body: JSON.stringify(validBody),
  };
  const binder = { AIG_GENERATION_SERVICE: { fetch: async () => new Response(null, { status: 204 }) }, AIG_GENERATION_AUTH_KEY: internalKey };
  const built = buildGenerationRequest(binder, invocation);
  assert.equal(built.headers.get('x-aig-generation-auth'), internalKey);
  assert.equal(built.headers.has('authorization'), false);
  assert.equal(built.headers.has('cookie'), false);
  assert.throws(() => buildGenerationRequest({}, invocation), GenerationCenterUnavailable);

  assert.deepEqual(quotaFromCenter(new Headers({ 'x-aig-quota-signal': '{"remainingRequests":3}' }))?.remainingRequests, 3);
  assert.equal(quotaFromCenter(new Headers({ 'x-aig-quota-signal': '{"remainingRequests":-1}' })), null);
  // A missing center must fail before a physical Provider request. This checks
  // the real Gateway dispatch selector, not only the private transport helper.
  const unboundState = {
    attempted: new Set(),
    attempts: [],
    logicalAttempts: 0,
    dispatches: 0,
    failureKinds: {},
    maxAttempts: 2,
    requestId: '12345678-1234-4234-8234-123456789012',
    requestedModel: 'image-test',
    logger: { info: () => {} },
  };
  const unboundAttempt = await attemptNode({
    request: new Request('https://client.example/v1/images/generations', { method: 'POST' }),
    env,
    route: 'openai_images',
    node: { ...node, tier: 'tier-2', protocol: 'openai', surfaces: ['images_generations'] },
    reqDescriptor: { model: 'image-test', protocol: 'openai', surface: 'images_generations' },
    bodyJson: validBody,
    conversionContext: null,
    requestId: unboundState.requestId,
    requestedModel: 'image-test',
    remainingDispatchableAttempts: 1,
    failoverBudgetMs: 60_000,
    requestStartMs: Date.now(),
    state: unboundState,
  });
  assert.equal(unboundAttempt.response?.status, 503);
  assert.equal(unboundAttempt.budgetCharged, false);
  assert.equal(unboundState.logicalAttempts, 0);
  assert.equal(unboundState.dispatches, 0);
  assert.equal(requests, 2, 'missing Generation Center must never call physical Provider');

  // The central image suite config must be accepted identically by the
  // Gateway and private center; production never bypasses invalid config.
  const imageModel = 'Image-Creator';
  const imageEnv = {
    AIG_GENERATION_AUTH_KEY: internalKey,
    AIG_ACCESS_KEY_AGENT: 'backend-agent-test-key',
    AIG_ACCESS_MODELS_AGENT: imageModel,
    AIG_ACCESS_KEY_AIR: 'frontend-air-test-key',
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_TIER1_NODES_01: JSON.stringify([
      { id: 'image-1', provider: 'openai-image', base_url: 'https://api.openai.com', models: { [imageModel]: 'gpt-image-1' } },
    ]),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'image-1': 'upstream-mock-secret' }),
    AIG_MODELS_CONFIG: JSON.stringify({
      [imageModel]: {
        policy: 'default',
        visibility: 'internal',
        ui_visible: false,
        group: 'image',
        modalities: { input: ['text'], output: ['image'] },
      },
    }),
    AIG_REQUEST_ADMISSION: 'false',
  };
  const imageConfig = loadExecutionConfig(imageEnv);
  assert.equal(imageConfig.hasConfigErrors, false, `central image config diagnostics: ${JSON.stringify(imageConfig.diagnostics)}`);
  assert.equal(imageConfig.ready, true, 'center image fixture must have a usable provider node');

  // Image generation is center-only even without a deployment marker. Gateway
  // can route image-only nodes using metadata without retaining Provider keys.
  const imageGatewayEnv = {
    AIG_ACCESS_KEY_AGENT: 'center-image-test-client-key',
    AIG_TIER2_NODES_01: env.AIG_TIER2_NODES_01,
  };
  const imageGatewayConfig = loadGatewayConfig(imageGatewayEnv);
  assert.equal(imageGatewayConfig.ready, true);
  assert.equal(imageGatewayConfig.nodes[0].credential, '');
  assert.equal(loadExecutionConfig(imageGatewayEnv).ready, false, 'private generation center still requires a Provider key');
  const imageGatewayWithSecret = loadGatewayConfig({
    ...imageGatewayEnv,
    AIG_TIER2_CREDENTIALS_01: env.AIG_TIER2_CREDENTIALS_01,
  });
  assert.equal(imageGatewayWithSecret.nodes[0].credential, '', 'Gateway must not retain a center-owned image key');
  assert.equal(loadExecutionConfig(env).nodes[0].credential, secret, 'private Generation Center owns its Provider key');

  console.log('Private generation center contracts passed.');
} finally {
  globalThis.fetch = originalFetch;
}
