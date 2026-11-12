#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Offline image-routing contract: real Gateway and Perception center, fake Provider only.

import assert from 'node:assert/strict';
import { handleRequest } from '../apps/gateway/request-handler.ts';
import { handlePerceptionCenterRequest } from '../apps/perception/index.ts';

const original = 'Code-Max';
const vision = 'Vision-Explicit';
const accessKey = 'local-vision-contract-key';
// A valid 2x2 red PNG: image bytes are sent through the full private-center path.
const image = {
  type: 'image_url',
  image_url: {
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGN8JiLCwMDAxMDAwMDAAAANpAESe7q5qgAAAABJRU5ErkJggg==',
  },
};

async function exercise({ allowFallback, provider = 'openai', bindCenter = true, expectedStatus, expectedCode }) {
  const providerCalls = [];
  const centerCalls = [];
  const nodes = [
    {
      id: 'text-only-key',
      provider: 'openai',
      base_url: 'https://provider.example.invalid/v1',
      models: { [original]: 'upstream-text-model' },
    },
    {
      id: 'vision-key',
      provider,
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
  };
  // The public Gateway has only routing metadata; credentials stay inside Perception.
  const centerEnv = {
    ...env,
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({
      'text-only-key': 'local-text-credential',
      'vision-key': 'local-vision-credential',
    }),
  };
  if (bindCenter) {
    env.AIG_PERCEPTION_SERVICE = {
      async fetch(request) {
        assert.equal(request.headers.get('authorization'), null, 'client auth must not cross the private boundary');
        assert.equal(request.headers.get('x-api-key'), null);
        assert.equal(request.headers.get('x-aig-perception-auth'), env.AIG_PERCEPTION_AUTH_KEY);
        const body = await request.clone().json();
        centerCalls.push({ nodeId: request.headers.get('x-aig-node-id'), model: body.model });
        assert.equal(body.model, vision);
        assert.ok(JSON.stringify(body).includes('image_url'), 'image data must be present at Perception');
        return handlePerceptionCenterRequest(request, centerEnv);
      },
    };
  }
  env.AIG_INFERENCE_SERVICE = {
    async fetch() {
      throw new Error('Image input must not be sent to the text-only inference center');
    },
  };

  const request = new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: original, messages: [{ role: 'user', content: [{ type: 'text', text: 'What is shown?' }, image] }] }),
  });

  // The only simulated hop is the external Provider; all internal production
  // entrypoints, credential resolution, model mapping, and transport execute.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    assert.equal(url, 'https://provider.example.invalid/v1/chat/completions');
    const body = JSON.parse(init.body);
    providerCalls.push({ model: body.model, hasImage: JSON.stringify(body).includes(image.image_url.url) });
    assert.equal(body.model, 'upstream-vision-model', 'Perception must apply the physical model mapping');
    assert.equal(providerCalls[0].hasImage, true, 'the upstream Provider must receive unmodified image content');
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-vision',
        object: 'chat.completion',
        created: 1,
        model: 'upstream-vision-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'image understood' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const response = await handleRequest(request, env, { waitUntil() {}, passThroughOnException() {} });
    const payload = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(payload));
    if (expectedStatus === 200) {
      assert.equal(payload.choices?.[0]?.message?.content, 'image understood');
      assert.deepEqual(centerCalls, [{ nodeId: 'vision-key', model: vision }]);
      assert.deepEqual(providerCalls, [{ model: 'upstream-vision-model', hasImage: true }]);
    } else {
      assert.equal(response.headers.get('x-gateway-error-code'), expectedCode);
      assert.equal(providerCalls.length, 0, 'invalid vision routing must never dispatch a Provider');
      assert.equal(centerCalls.length, 0, 'invalid vision routing must not reach Perception');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await exercise({ allowFallback: false, expectedStatus: 400, expectedCode: 'gateway_image_input_unsupported' });
await exercise({ allowFallback: true, expectedStatus: 200 });
await exercise({
  allowFallback: true,
  provider: 'unverified-provider',
  expectedStatus: 400,
  expectedCode: 'gateway_image_provider_unsupported',
});
await exercise({
  allowFallback: true,
  bindCenter: false,
  expectedStatus: 503,
  expectedCode: 'gateway_perception_center_unavailable',
});
console.log('Gateway -> real Perception -> fake Provider and zero-dispatch failure contracts passed offline.');
