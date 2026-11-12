#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Private conversion admission: six protocol pairs, fail-closed and no Provider.
import assert from 'node:assert/strict';
import { buildInferencePreflightHeaders, INFERENCE_PREFLIGHT_PATH } from '../packages/contracts/conversion-preflight.ts';
import { parseTraceparent, traceIdForRequest } from '../packages/contracts/trace-context.ts';
import { highRiskSemanticLoss } from '../packages/conversion-core/fidelity-policy.ts';
import { ConversionError } from '../packages/conversion-core/validation.ts';
import { handleInferenceCenterRequest } from '../src/inference/inference-center-entry.ts';
import { InferenceCenterUnavailable } from '../src/inference/inference-client-request.ts';
import { checkInferenceConversion } from '../src/inference/inference-preflight-client.ts';

const key = 'local-inference-preflight-contract-auth-key-32';
const requestId = '12345678-1234-4234-8234-123456789012';
const client = new Request('https://gateway.invalid/v1/messages', {
  method: 'POST',
  headers: {
    authorization: 'Bearer private-client-token',
    cookie: 'session=private',
    traceparent: '00-ffffffffffffffffffffffffffffffff-0123456789abcdef-01',
    tracestate: 'client=secret',
  },
});
const bodyByProtocol = {
  openai_chat: { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] },
  anthropic: { model: 'test-model', max_tokens: 128, messages: [{ role: 'user', content: 'hello' }] },
  openai_responses: { model: 'test-model', input: 'hello' },
};
let upstreamAttempts = 0;
let checks = 0;
const env = {
  AIG_INFERENCE_AUTH_KEY: key,
  AIG_INFERENCE_SERVICE: {
    fetch: async (request) => {
      checks++;
      assert.equal(new URL(request.url).pathname, INFERENCE_PREFLIGHT_PATH);
      assert.equal(request.headers.has('authorization'), false);
      assert.equal(request.headers.has('cookie'), false);
      assert.equal(request.headers.get('x-aig-inference-auth'), key);
      assert.equal(parseTraceparent(request.headers.get('traceparent'))?.traceId, traceIdForRequest(requestId));
      assert.equal(request.headers.has('tracestate'), false);
      assert.notEqual(request.headers.get('traceparent'), client.headers.get('traceparent'));

      return handleInferenceCenterRequest(request, env);
    },
  },
};
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => {
    upstreamAttempts++;
    throw new Error('preflight must never call a Provider');
  };
  for (const from of Object.keys(bodyByProtocol)) {
    for (const to of Object.keys(bodyByProtocol)) {
      if (from === to) continue;
      const requestBody = bodyByProtocol[from];
      const result = await checkInferenceConversion(env, {
        request: client,
        requestId,
        from,
        to,
        body: requestBody,
        isNonstreamPreferred: false,
        deadlineMs: Date.now() + 15_000,
      });
      assert.equal(result.body, requestBody, 'preflight never copies translated content back to Gateway');
      assert.ok(Array.isArray(result.diagnostics));
      assert.ok(['exact', 'portable', 'degraded'].includes(result.fidelity));
    }
  }
  assert.equal(checks, 6);
  assert.equal(upstreamAttempts, 0);

  await assert.rejects(
    checkInferenceConversion(env, {
      request: client,
      requestId,
      from: 'openai_chat',
      to: 'anthropic',
      body: { ...bodyByProtocol.openai_chat, unexpected: true },
      isNonstreamPreferred: false,
      deadlineMs: Date.now() + 15_000,
    }),
    (error) => error instanceof ConversionError && error.requestField === 'unexpected',
  );
  assert.equal(checks, 7);
  assert.equal(upstreamAttempts, 0);

  // Native Provider tools cannot be represented as portable function tools.
  // A preflight may report loss, but must never disclose translated payloads
  // or allow Gateway to bypass Inference's independent safety decision.
  const nativeToolName = 'sensitive-native-tool-name';
  const nativeOnly = {
    ...bodyByProtocol.anthropic,
    tools: [{ type: 'web_search_20250305', name: nativeToolName }],
  };
  const nativeResult = await checkInferenceConversion(env, {
    request: client,
    requestId,
    from: 'anthropic',
    to: 'openai_chat',
    body: nativeOnly,
    isNonstreamPreferred: false,
    deadlineMs: Date.now() + 15_000,
  });
  assert.strictEqual(nativeResult.body, nativeOnly, 'preflight returns only the original request object');
  assert.equal(nativeResult.fidelity, 'degraded');
  assert.deepEqual(highRiskSemanticLoss(nativeResult), ['provider_native_tool']);
  assert.equal(JSON.stringify(nativeResult.diagnostics).includes(nativeToolName), false, 'diagnostics never leak tool names');
  assert.equal(checks, 8);
  assert.equal(upstreamAttempts, 0);

  // Optional server tools alongside a portable function tool are a declared
  // capability loss, not a request whose entire tool interface was lost.
  const mixedTools = {
    ...nativeOnly,
    tools: [
      { name: 'local_lookup', input_schema: { type: 'object', properties: {} } },
      { type: 'web_search_20250305', name: nativeToolName },
    ],
  };
  const mixedResult = await checkInferenceConversion(env, {
    request: client,
    requestId,
    from: 'anthropic',
    to: 'openai_chat',
    body: mixedTools,
    isNonstreamPreferred: false,
    deadlineMs: Date.now() + 15_000,
  });
  assert.deepEqual(highRiskSemanticLoss(mixedResult), []);
  assert.ok(mixedResult.diagnostics.some((entry) => entry.feature === 'provider_native_tool_definition' && entry.action === 'dropped'));
  assert.equal(checks, 9);
  assert.equal(upstreamAttempts, 0);

  const headers = buildInferencePreflightHeaders({ requestId, deadlineMs: Date.now() + 15_000 }, key);
  headers.set('x-aig-preflight-version', '2');
  assert.equal(
    (
      await handleInferenceCenterRequest(
        new Request('https://inference.internal/internal/conversion/preflight', {
          method: 'POST',
          headers,
          body: JSON.stringify({ from: 'openai_chat', to: 'anthropic', body: bodyByProtocol.openai_chat }),
        }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(upstreamAttempts, 0);

  // An unbound Gateway must fail closed rather than perform an old
  // in-process conversion or a direct Provider attempt.
  await assert.rejects(
    checkInferenceConversion(
      { AIG_INFERENCE_AUTH_KEY: key },
      {
        request: client,
        requestId,
        from: 'openai_chat',
        to: 'anthropic',
        body: bodyByProtocol.openai_chat,
        isNonstreamPreferred: false,
        deadlineMs: Date.now() + 15_000,
      },
    ),
    InferenceCenterUnavailable,
  );
  assert.equal(upstreamAttempts, 0);

  const unavailable = {
    ...env,
    AIG_INFERENCE_SERVICE: {
      fetch: async () => {
        throw new Error('network down');
      },
    },
  };
  await assert.rejects(
    checkInferenceConversion(unavailable, {
      request: client,
      requestId,
      from: 'anthropic',
      to: 'openai_chat',
      body: bodyByProtocol.anthropic,
      isNonstreamPreferred: false,
      deadlineMs: Date.now() + 15_000,
    }),
    InferenceCenterUnavailable,
  );
  assert.equal(upstreamAttempts, 0);
  console.log('Inference preflight: six directional pairs, no translated payload disclosure, fail-closed and zero physical attempts passed.');
} finally {
  globalThis.fetch = originalFetch;
}
