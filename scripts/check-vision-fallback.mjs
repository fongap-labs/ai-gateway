#!/usr/bin/env node
import assert from 'node:assert/strict';
import { handleRequest } from '../apps/gateway/request-handler.ts';
import { handleInferenceCenterRequest } from '../apps/inference/index.ts';
import { handlePerceptionCenterRequest } from '../apps/perception/index.ts';

const original = 'Code-Max';
const vision = 'Vision-Explicit';
const accessKey = 'local-vision-contract-key';
const image = {
  type: 'image_url',
  image_url: {
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGN8JiLCwMDAxMDAwMDAAAANpAESe7q5qgAAAABJRU5ErkJggg==',
  },
};

async function exercise({
  allowFallback,
  provider = 'openai',
  bindCenter = true,
  expectedStatus,
  expectedCode,
  includeUnsupportedVisionSibling = false,
  restrictAccess = false,
}) {
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
  if (includeUnsupportedVisionSibling) {
    nodes.splice(1, 0, {
      id: 'incompatible-vision-key',
      provider: 'unverified-provider',
      base_url: 'https://provider.example.invalid/v1',
      models: { [vision]: 'upstream-incompatible-model' },
    });
  }
  const env = {
    AIG_ACCESS_KEY_AIR: accessKey,
    AIG_ACCESS_MODELS_AIR: restrictAccess ? original : '*',
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
  const centerEnv = {
    ...env,
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({
      'text-only-key': 'local-text-credential',
      'vision-key': 'local-vision-credential',
      ...(includeUnsupportedVisionSibling ? { 'incompatible-vision-key': 'local-incompatible-key' } : {}),
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

await exercise({ allowFallback: false, restrictAccess: true, expectedStatus: 400, expectedCode: 'gateway_image_input_unsupported' });
await exercise({ allowFallback: true, expectedStatus: 200 });
await exercise({ allowFallback: true, includeUnsupportedVisionSibling: true, expectedStatus: 200 });
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

const bridgeModel = 'Omni';
const bridgeProviderCalls = [];
const bridgeCenterCalls = [];
const bridgeEnv = {
  AIG_ACCESS_KEY_AIR: accessKey,
  AIG_ACCESS_MODELS_AIR: '*',
  AIG_INFERENCE_AUTH_KEY: 'i'.repeat(32),
  AIG_PERCEPTION_AUTH_KEY: 'v'.repeat(32),
  AIG_REQUEST_ADMISSION: 'false',
  AIG_TIER1_NODES_01: JSON.stringify([
    { id: 'bridge-code', provider: 'openai', base_url: 'https://provider.example.invalid/v1', models: { [original]: 'upstream-text-model' } },
    { id: 'bridge-vision', provider: 'openai', base_url: 'https://provider.example.invalid/v1', models: { [bridgeModel]: 'upstream-vision-model' } },
  ]),
  AIG_MODELS_CONFIG: JSON.stringify({
    [original]: { policy: 'default', capabilities: { vision: false }, vision_delegate: bridgeModel },
    [bridgeModel]: { policy: 'default', capabilities: { vision: true } },
  }),
  AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 2, tier_attempts: { tier1: 2 }, hedge: { enabled: false } } }),
};
const bridgeCenterEnv = {
  ...bridgeEnv,
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'bridge-code': 'local-text-key', 'bridge-vision': 'local-vision-key' }),
};
bridgeEnv.AIG_PERCEPTION_SERVICE = {
  async fetch(req) {
    bridgeCenterCalls.push('perception');
    assert.equal(req.headers.get('x-aig-node-id'), 'bridge-vision');
    return handlePerceptionCenterRequest(req, bridgeCenterEnv);
  },
};
bridgeEnv.AIG_INFERENCE_SERVICE = {
  async fetch(req) {
    bridgeCenterCalls.push('inference');
    assert.equal(req.headers.get('x-aig-node-id'), 'bridge-code');
    const body = await req.clone().json();
    assert.equal(JSON.stringify(body).includes('image_url'), false, 'text model must not receive image bytes');
    assert.match(JSON.stringify(body), /Visual observations/);
    assert.match(JSON.stringify(body), /red square/);
    return handleInferenceCenterRequest(req, bridgeCenterEnv);
  },
};
const bridgeRequest = () =>
  new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: original, messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, image] }] }),
  });
const bridgeOriginalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(init.body);
  bridgeProviderCalls.push(body.model);
  if (body.model === 'upstream-vision-model') {
    assert.equal(JSON.stringify(body).includes('image_url'), true);
  } else {
    assert.equal(body.model, 'upstream-text-model');
    assert.equal(JSON.stringify(body).includes('image_url'), false);
  }
  if (body.model === 'upstream-text-model' && Array.isArray(body.input)) {
    return new Response(
      JSON.stringify({
        id: 'resp-bridge',
        object: 'response',
        status: 'completed',
        created_at: 1,
        model: body.model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A red square is shown.' }] }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(
    JSON.stringify({
      id: 'mock-bridge',
      object: 'chat.completion',
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: body.model === 'upstream-vision-model' ? 'A red square.' : 'A red square is shown.' },
          finish_reason: 'stop',
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
try {
  const result = await handleRequest(bridgeRequest(), bridgeEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(result.status, 200, await result.text());
  assert.deepEqual(bridgeCenterCalls, ['perception', 'inference']);
  assert.deepEqual(bridgeProviderCalls, ['upstream-vision-model', 'upstream-text-model']);

  const responsesImageRequest = (block) =>
    new Request('https://gateway.example.invalid/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: original,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'What is shown?' }, block] }],
      }),
    });
  const responsesImage = { type: 'input_image', image_url: image.image_url.url };
  const responsesResult = await handleRequest(responsesImageRequest(responsesImage), bridgeEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(responsesResult.status, 200, await responsesResult.clone().text());
  assert.equal((await responsesResult.json()).output?.[0]?.content?.[0]?.text, 'A red square is shown.');
  assert.deepEqual(bridgeCenterCalls, ['perception', 'inference', 'perception', 'inference']);
  assert.deepEqual(bridgeProviderCalls, ['upstream-vision-model', 'upstream-text-model', 'upstream-vision-model', 'upstream-text-model']);

  const anthropicImageRequest = (source) =>
    new Request('https://gateway.example.invalid/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': accessKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: original,
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', source },
            ],
          },
        ],
      }),
    });
  const anthropicImageSource = {
    type: 'base64',
    media_type: 'image/png',
    data: image.image_url.url.split(',')[1],
  };
  const anthropicResult = await handleRequest(anthropicImageRequest(anthropicImageSource), bridgeEnv, {
    waitUntil() {},
    passThroughOnException() {},
  });
  assert.equal(anthropicResult.status, 200, await anthropicResult.clone().text());
  assert.match(JSON.stringify(await anthropicResult.json()), /red square/i);
  assert.deepEqual(bridgeCenterCalls.slice(-2), ['perception', 'inference']);
  assert.deepEqual(bridgeProviderCalls.slice(-2), ['upstream-vision-model', 'upstream-text-model']);

  const listRequest = () => new Request('https://gateway.example.invalid/v1/models', { headers: { 'x-api-key': accessKey } });
  const list = await (await handleRequest(listRequest(), bridgeEnv, {})).json();
  assert.equal(list.data.find((entry) => entry.id === original)?.supports_vision, true);
  assert.equal(list.data.find((entry) => entry.id === bridgeModel)?.supports_vision, true);
  const unavailableList = await (await handleRequest(listRequest(), { ...bridgeEnv, AIG_PERCEPTION_SERVICE: undefined }, {})).json();
  assert.equal(unavailableList.data.find((entry) => entry.id === original)?.supports_vision, false);
  const restrictedList = await (await handleRequest(listRequest(), { ...bridgeEnv, AIG_ACCESS_MODELS_AIR: original }, {})).json();
  assert.equal(restrictedList.data.find((entry) => entry.id === original)?.supports_vision, false);

  const autoEnv = {
    ...bridgeEnv,
    AIG_MODELS_CONFIG: JSON.stringify({
      [original]: { policy: 'default', capabilities: { vision: false } },
      [bridgeModel]: { policy: 'default', capabilities: { vision: true } },
    }),
  };
  const autoList = await (await handleRequest(listRequest(), autoEnv, {})).json();
  assert.equal(autoList.data.find((entry) => entry.id === original)?.supports_vision, true);
  const autoResult = await handleRequest(bridgeRequest(), autoEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(autoResult.status, 200, await autoResult.clone().text());
  assert.deepEqual(bridgeCenterCalls.slice(-2), ['perception', 'inference']);
  const blockedAutoEnv = { ...autoEnv, AIG_ACCESS_MODELS_AIR: original };
  const blockedAutoList = await (await handleRequest(listRequest(), blockedAutoEnv, {})).json();
  assert.equal(blockedAutoList.data.find((entry) => entry.id === original)?.supports_vision, false);
  const blockedAuto = await handleRequest(bridgeRequest(), blockedAutoEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(blockedAuto.status, 400);
  assert.equal(blockedAuto.headers.get('x-gateway-error-code'), 'gateway_image_input_unsupported');

  const unsupportedAnthropic = await handleRequest(anthropicImageRequest({ type: 'file', file_id: 'file-123' }), bridgeEnv, {
    waitUntil() {},
    passThroughOnException() {},
  });
  assert.equal(unsupportedAnthropic.status, 400);
  assert.equal(unsupportedAnthropic.headers.get('x-gateway-error-code'), 'gateway_vision_preprocess_shape_unsupported');

  const unsupportedFile = await handleRequest(responsesImageRequest({ type: 'input_image', file_id: 'file-123' }), bridgeEnv, {
    waitUntil() {},
    passThroughOnException() {},
  });
  assert.equal(unsupportedFile.status, 400, 'unsupported image file IDs must not be silently dropped or fetched');
  assert.equal(bridgeProviderCalls.length, 8, 'no Provider dispatch on unsupported file ID');

  const unauthorized = { ...bridgeEnv, AIG_ACCESS_MODELS_AIR: original };
  const denied = await handleRequest(bridgeRequest(), unauthorized, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(denied.status, 403, "an unauthorized vision alias must never be used behind the caller's back");
  assert.equal((await denied.json()).error?.details?.gateway_code, 'gateway_vision_preprocess_unauthorized');
  assert.equal(bridgeProviderCalls.length, 8, 'unauthorized delegate must not dispatch');
} finally {
  globalThis.fetch = bridgeOriginalFetch;
}

for (const [field, payload] of [
  ['tools', { tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object' } } }] }],
  ['stream', { stream: true }],
]) {
  const capEnv = {
    AIG_ACCESS_KEY_AIR: accessKey,
    AIG_ACCESS_MODELS_AIR: original,
    AIG_TIER1_NODES_01: JSON.stringify([
      { id: 'cap-incompatible', provider: 'openai', base_url: 'https://provider.example.invalid/v1', models: { [original]: 'cap-physical' } },
    ]),
    AIG_MODELS_CONFIG: JSON.stringify({
      [original]: { policy: 'default', capabilities: { tools: field !== 'tools', stream: field !== 'stream' } },
    }),
  };
  const req = new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: original, messages: [{ role: 'user', content: 'test' }], ...payload }),
  });
  const reply = await handleRequest(req, capEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(reply.status, 400, field);
  assert.equal(reply.headers.get('x-gateway-error-code'), 'gateway_model_capability_unsupported', field);
}

console.log('Gateway -> real Perception -> fake Provider and zero-dispatch failure contracts passed offline.');
