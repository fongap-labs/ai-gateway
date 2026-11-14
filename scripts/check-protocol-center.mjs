#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Private Protocol Center: six protocol pairs, semantic safety, no Provider, no credential leaks.
import assert from 'node:assert/strict';
import { checkInferenceConversion } from '../apps/gateway/transport/inference-preflight-client.ts';
import { handleProtocolCenterRequest } from '../apps/protocol/index.ts';
import { buildProtocolPreflightHeaders, PROTOCOL_PREFLIGHT_PATH } from '../packages/contracts/conversion-preflight.ts';
import { highRiskSemanticLoss } from '../packages/conversion-core/fidelity-policy.ts';
import { ConversionError } from '../packages/conversion-core/validation.ts';

const key = 'test-private-protocol-center-auth-key-32';
const requestId = '12345678-1234-4234-8234-123456789012';
const client = new Request('https://gateway.invalid/v1/messages', {
  method: 'POST',
  headers: { authorization: 'Bearer private-client', cookie: 'private=secret', 'x-api-key': 'private-client' },
});
const inputs = {
  openai_chat: { model: 'test', messages: [{ role: 'user', content: 'hello' }] },
  openai_responses: { model: 'test', input: 'hello' },
  anthropic: { model: 'test', max_tokens: 128, messages: [{ role: 'user', content: 'hello' }] },
};
let checks = 0;
let providerAttempts = 0;
const env = {
  AIG_PROTOCOL_AUTH_KEY: key,
  AIG_PROTOCOL_SERVICE: {
    async fetch(request) {
      checks++;
      assert.equal(new URL(request.url).pathname, PROTOCOL_PREFLIGHT_PATH);
      assert.equal(request.headers.get('x-aig-protocol-auth'), key);
      for (const sensitive of ['authorization', 'cookie', 'x-api-key', 'x-aig-inference-auth', 'tracestate']) {
        assert.equal(request.headers.has(sensitive), false, sensitive);
      }
      return handleProtocolCenterRequest(request, env);
    },
  },
  AIG_INFERENCE_SERVICE: {
    fetch: async () => {
      throw new Error('Legacy center must be bypassed');
    },
  },
};
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => {
    providerAttempts++;
    throw new Error('Forbidden Provider request');
  };
  const health = await handleProtocolCenterRequest(
    new Request('https://protocol.internal/internal/health', { headers: { 'x-aig-protocol-auth': key } }),
    env,
  );
  assert.equal(health.status, 200);
  const unauthorized = await handleProtocolCenterRequest(new Request('https://protocol.internal/internal/health'), {});
  assert.equal(unauthorized.status, 403);
  for (const from of Object.keys(inputs)) {
    for (const to of Object.keys(inputs)) {
      if (from === to) continue;
      const result = await checkInferenceConversion(env, {
        request: client,
        requestId,
        from,
        to,
        body: inputs[from],
        isNonstreamPreferred: false,
        deadlineMs: Date.now() + 15_000,
      });
      assert.strictEqual(result.body, inputs[from], 'Gateway never receives translated request');
      assert.ok(Array.isArray(result.diagnostics));
    }
  }
  assert.equal(checks, 6);
  const invalidRequest = checkInferenceConversion(env, {
    request: client,
    requestId,
    from: 'openai_chat',
    to: 'anthropic',
    body: { ...inputs.openai_chat, unknown_field: true },
    isNonstreamPreferred: false,
    deadlineMs: Date.now() + 15_000,
  });
  await assert.rejects(invalidRequest, (e) => e instanceof ConversionError && e.requestField === 'unknown_field');

  const nativeOnly = { ...inputs.anthropic, tools: [{ type: 'web_search_20250305', name: 'secret-tool-name' }] };
  const converted = await checkInferenceConversion(env, {
    request: client,
    requestId,
    from: 'anthropic',
    to: 'openai_chat',
    body: nativeOnly,
    isNonstreamPreferred: false,
    deadlineMs: Date.now() + 15_000,
  });
  assert.deepEqual(highRiskSemanticLoss(converted), ['provider_native_tool']);
  assert.equal(JSON.stringify(converted.diagnostics).includes('secret-tool-name'), false);

  const headers = buildProtocolPreflightHeaders({ requestId, deadlineMs: Date.now() + 15_000 }, key);
  headers.set('x-aig-preflight-version', 'invalid');
  const invalidVersion = await handleProtocolCenterRequest(
    new Request('https://protocol.internal' + PROTOCOL_PREFLIGHT_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: 'openai_chat', to: 'anthropic', body: inputs.openai_chat }),
    }),
    env,
  );
  assert.equal(invalidVersion.status, 400);

  const missingCredential = checkInferenceConversion(
    { AIG_PROTOCOL_SERVICE: env.AIG_PROTOCOL_SERVICE },
    {
      request: client,
      requestId,
      from: 'anthropic',
      to: 'openai_chat',
      body: inputs.anthropic,
      isNonstreamPreferred: false,
      deadlineMs: Date.now() + 15_000,
    },
  );
  await assert.rejects(missingCredential, /Private inference center is not configured/);
  assert.equal(providerAttempts, 0);
  console.log('Protocol Center private preflight contract passed (6 pairs, fail-closed, zero physical attempts).');
} finally {
  globalThis.fetch = originalFetch;
}
