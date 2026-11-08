#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Native HTTP Request/Response transport tests. No Cloudflare account,
// external provider request, OAuth token or deployment required.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGenerationRequest, GenerationCenterUnavailable, invokeGenerationNode } from '../apps/gateway/transport/generation-client-request.ts';
import { buildInferenceRequest, InferenceCenterUnavailable, invokeInferenceNode } from '../apps/gateway/transport/inference-client-request.ts';

// Gateway owns both private Center clients. The old paths remain lightweight
// compatibility exports only; no execution, HTTP or secret policy may drift
// back into src/inference or src/generation.
for (const [kind, oldPath] of [
  ['inference', 'inference'],
  ['generation', 'generation'],
]) {
  const owner = readFileSync(new URL(`../apps/gateway/transport/${kind}-client-request.ts`, import.meta.url), 'utf8');
  const shim = readFileSync(new URL(`../src/${oldPath}/${kind}-client-request.ts`, import.meta.url), 'utf8');
  const caller = readFileSync(new URL(`../src/request/attempt/${kind}-dispatch.ts`, import.meta.url), 'utf8');
  assert.match(owner, /export async function invoke(?:Inference|Generation)Node\(/, `${kind} Gateway client owns transport`);
  assert.match(shim, new RegExp(`export \\* from ['"]\.\.\/\.\.\/apps\/gateway\/transport\/${kind}-client-request\.ts['"];`), `${kind} legacy file is a pure re-export`);
  assert.doesNotMatch(shim, /function |await fetch\(|class /, `${kind} legacy path cannot regain physical transport`);
  assert.match(caller, new RegExp(`apps\/gateway\/transport\/${kind}-client-request\.ts`), `${kind} attempt imports Gateway-owned transport directly`);
}

const inferenceKey = 'test-inference-center-authentication-32-plus';
const generationKey = 'test-generation-center-authentication-32-plus';
const id = '12345678-1234-4234-8234-123456789012';
const now = Date.now();
let invocations = 0;
const calls = [];
const privateHttpTransport = {
  async fetch(request) {
    invocations++;
    calls.push(request);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('x-aig-contract-version'), '1');
    assert.equal(request.headers.get('x-aig-request-id'), id);
    assert.equal(request.headers.get('x-aig-node-id'), 'mock-node');
    if (request.headers.has('x-aig-inference-auth')) {
      assert.equal(
        Number(request.headers.get('content-length')),
        new Blob([await request.clone().text()]).size,
        'inference center receives exact UTF-8 private body length',
      );
    }
    assert.equal(request.headers.has('authorization'), false);
    assert.equal(request.headers.has('cookie'), false);
    assert.equal(request.headers.has('x-api-key'), false);
    assert.equal(request.headers.has('x-aig-client-secret'), false);
    assert.equal((await request.json()).model, 'code-pro');
    return new Response('{"model":"code-pro","ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' },
    });
  },
};
const clientRequest = new Request('https://client.example/v1/chat/completions', {
  method: 'POST',
  headers: {
    authorization: 'Bearer client-private-key',
    cookie: 'session=hidden',
    'x-api-key': 'client-private-key',
    'x-aig-inference-auth': 'forged',
    'x-aig-generation-auth': 'forged',
    'anthropic-version': '2023-06-01',
    'idempotency-key': 'test-idempotency',
  },
});
const inference = {
  request: clientRequest,
  requestId: id,
  node: { id: 'mock-node' },
  logicalModel: 'code-pro',
  surface: 'chat_completions',
  deadlineMs: now + 60_000,
  body: JSON.stringify({ model: 'code-pro', messages: [] }),
};
const inferenceEnv = { AIG_INFERENCE_SERVICE: privateHttpTransport, AIG_INFERENCE_AUTH_KEY: inferenceKey };
const inferenceRequest = buildInferenceRequest(inferenceEnv, inference);
assert.equal(inferenceRequest.headers.get('x-aig-inference-auth'), inferenceKey);
assert.equal(inferenceRequest.headers.get('anthropic-version'), '2023-06-01');
assert.equal(inferenceRequest.headers.get('idempotency-key'), 'test-idempotency');
assert.equal(inferenceRequest.headers.has('x-aig-generation-auth'), false);
assert.equal((await invokeInferenceNode(inferenceEnv, inference)).status, 200);
assert.equal(invocations, 1);
assert.throws(() => buildInferenceRequest({}, inference), InferenceCenterUnavailable);
await assert.rejects(() => invokeInferenceNode({ AIG_INFERENCE_AUTH_KEY: inferenceKey }, inference), InferenceCenterUnavailable);
assert.equal(invocations, 1);

const generation = {
  ...inference,
  body: JSON.stringify({ model: 'code-pro', prompt: 'test' }),
};
const generationEnv = { AIG_GENERATION_SERVICE: privateHttpTransport, AIG_GENERATION_AUTH_KEY: generationKey };
const generationRequest = buildGenerationRequest(generationEnv, generation);
assert.equal(generationRequest.headers.get('x-aig-generation-auth'), generationKey);
assert.equal(generationRequest.headers.get('x-aig-surface'), 'images_generations');
assert.equal(generationRequest.headers.has('x-aig-inference-auth'), false);
assert.equal(generationRequest.headers.has('idempotency-key'), false);
assert.equal((await invokeGenerationNode(generationEnv, generation)).status, 200);
assert.equal(invocations, 2);
assert.throws(() => buildGenerationRequest({}, generation), GenerationCenterUnavailable);
await assert.rejects(() => invokeGenerationNode({ AIG_GENERATION_AUTH_KEY: generationKey }, generation), GenerationCenterUnavailable);
assert.equal(invocations, 2);
assert.equal(
  calls.every((call) => call.url.endsWith('/internal/execute')),
  true,
);
console.log('Both centers passed standard HTTP Mock transport and isolation contracts.');
