#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Explicit vision fallback contract with fake private Service Bindings.

import assert from 'node:assert/strict';
import { handleRequest } from '../apps/gateway/request-handler.ts';

const original = 'Code-Max';
const vision = 'Vision-Explicit';
const accessKey = 'local-vision-contract-key';
const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } };

async function exercise(allowFallback) {
  const calls = [];
  const nodes = [
    {
      id: 'text-only-key',
      provider: 'openai',
      base_url: 'https://provider.example.invalid/v1',
      models: { [original]: 'upstream-text-model' },
    },
    {
      id: 'vision-key',
      provider: 'openai',
      base_url: 'https://provider.example.invalid/v1',
      models: { [vision]: 'upstream-vision-model' },
    },
  ];
  const env = {
    AIG_ACCESS_KEY_AIR: accessKey,
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_TIER1_NODES_01: JSON.stringify(nodes),
    AIG_INFERENCE_AUTH_KEY: 'i'.repeat(32),
    AIG_PERCEPTION_AUTH_KEY: 'v'.repeat(32),
    AIG_MODELS_CONFIG: JSON.stringify({
      [original]: { policy: 'default', capabilities: { vision: false }, ...(allowFallback ? { fallback: [vision] } : {}) },
      [vision]: { policy: 'default', capabilities: { vision: true } },
    }),
    AIG_POLICIES_CONFIG: JSON.stringify({
      default: { max_attempts: 2, tier_attempts: { tier1: 2 }, hedge: { enabled: false } },
    }),
    AIG_PERCEPTION_SERVICE: {
      async fetch(request) {
        const physicalId = request.headers.get('x-aig-node-id');
        const body = await request.json();
        calls.push({ physicalId, model: body.model });
        assert.equal(physicalId, 'vision-key');
        assert.equal(body.model, vision, 'Perception must receive the explicit vision fallback model');
        assert.ok(JSON.stringify(body).includes('image_url'), 'image data must not be silently stripped');
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-vision',
            object: 'chat.completion',
            created: 1,
            model: vision,
            choices: [{ index: 0, message: { role: 'assistant', content: 'image understood' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' } },
        );
      },
    },
    AIG_INFERENCE_SERVICE: {
      async fetch() {
        throw new Error('An image request must never reach a text-only center');
      },
    },
  };
  const request = new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: original, messages: [{ role: 'user', content: [{ type: 'text', text: 'What is shown?' }, image] }] }),
  });
  const response = await handleRequest(request, env, { waitUntil() {}, passThroughOnException() {} });
  const payload = await response.json();
  if (allowFallback) {
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.choices?.[0]?.message?.content, 'image understood');
    assert.deepEqual(calls, [{ physicalId: 'vision-key', model: vision }]);
  } else {
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(response.headers.get('x-gateway-error-code'), 'gateway_image_input_unsupported');
    assert.equal(calls.length, 0, 'without explicit vision fallback, no Provider dispatch is permitted');
  }
}

await exercise(false);
await exercise(true);
console.log('Explicit image fallback via Perception and fail-closed no-fallback contracts passed offline.');
