#!/usr/bin/env node
import assert from 'node:assert/strict';
import { handleRequest } from '../apps/gateway/request-handler.ts';
import { handlePerceptionCenterRequest } from '../apps/perception/index.ts';
import { getModelsConfigDiagnostics, loadModelsConfig } from '../packages/config-core/models.ts';

const textModel = 'Code-Max';
const visionModel = 'Omni';
const key = 'local-vision-native-regression-key';
const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGN8JiLCwMDAxMDAwMDAAAANpAESe7q5qgAAAABJRU5ErkJggg==';
const image = { type: 'image_url', image_url: { url: imageUrl } };
const ctx = { waitUntil() {}, passThroughOnException() {} };

function requestFor(route, model) {
  const body = route === 'chat'
    ? { model, messages: [{ role: 'user', content: [{ type: 'text', text: 'What is shown?' }, image] }], stream: false }
    : route === 'responses'
      ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'What is shown?' }, { type: 'input_image', image_url: imageUrl }] }], stream: false }
      : { model, max_tokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'What is shown?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageUrl.split(',')[1] } }] }] };
  const path = route === 'chat' ? '/v1/chat/completions' : route === 'responses' ? '/v1/responses' : '/v1/messages';
  return new Request('https://gateway.example.invalid' + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...(route === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) },
    body: JSON.stringify(body),
  });
}

async function exercise({ route = 'chat', model = textModel, fallback = false, legacyDelegate = false, provider = 'openai', bindPerception = true, expectedStatus, expectedCode }) {
  const calls = { inference: 0, perception: 0, provider: 0 };
  const env = {
    AIG_ACCESS_KEY_AIR: key,
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_TIER1_NODES_01: JSON.stringify([
      { id: 'native-text', provider: 'openai', base_url: 'https://provider.example.invalid/v1', models: { [textModel]: 'provider-text' } },
      { id: 'native-vision', provider, base_url: 'https://provider.example.invalid/v1', models: { [visionModel]: 'provider-vision' } },
    ]),
    AIG_INFERENCE_AUTH_KEY: 'i'.repeat(32),
    AIG_PERCEPTION_AUTH_KEY: 'v'.repeat(32),
    AIG_MODELS_CONFIG: JSON.stringify({
      [textModel]: { policy: 'default', capabilities: { vision: false }, ...(fallback ? { fallback: [visionModel] } : {}), ...(legacyDelegate ? { vision_delegate: visionModel } : {}) },
      [visionModel]: { policy: 'default', capabilities: { vision: true }, modalities: { input: ['text', 'image'], output: ['text'] } },
    }),
    AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 2, tier_attempts: { tier1: 2 }, hedge: { enabled: false } } }),
  };
  const centerEnv = { ...env, AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'native-vision': 'local-vision-token', 'native-text': 'local-text-token' }) };
  env.AIG_INFERENCE_SERVICE = { async fetch() { calls.inference++; throw new Error('Image-bearing test must not reach text inference'); } };
  if (bindPerception) {
    env.AIG_PERCEPTION_SERVICE = {
      async fetch(internal) {
        calls.perception++;
        assert.equal(internal.headers.get('x-aig-node-id'), 'native-vision');
        assert.equal(internal.headers.get('x-aig-perception-auth'), env.AIG_PERCEPTION_AUTH_KEY);
        assert.equal(internal.headers.get('authorization'), null);
        const body = await internal.clone().json();
        assert.equal(body.model, visionModel);
        assert.ok(JSON.stringify(body).includes(imageUrl));
        return handlePerceptionCenterRequest(internal, centerEnv);
      },
    };
  }

  assert.deepEqual(getModelsConfigDiagnostics(env), [], 'retired config key must not break an existing deployment');
  const listed = await handleRequest(
    new Request('https://gateway.example.invalid/v1/models', { headers: { authorization: 'Bearer ' + key } }),
    env,
    ctx,
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  const listedModels = (await listed.json()).data;
  assert.equal(listedModels.find((item) => item.id === textModel)?.supports_vision, false);
  assert.equal(
    listedModels.find((item) => item.id === visionModel)?.supports_vision,
    bindPerception && provider === 'openai',
  );

  assert.equal(loadModelsConfig(env)[textModel].policy.vision_delegate, undefined);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    calls.provider++;
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'provider-vision');
    assert.ok(JSON.stringify(body).includes(imageUrl));
    return new Response(JSON.stringify({
      id: 'chatcmpl-vision', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'image understood' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await handleRequest(requestFor(route, model), env, ctx);
    assert.equal(result.status, expectedStatus, await result.clone().text());
    if (expectedStatus === 200) {
      const payload = await result.json();
      assert.equal(payload.choices?.[0]?.message?.content, 'image understood');
      assert.deepEqual(calls, { inference: 0, perception: 1, provider: 1 });
    } else {
      assert.equal(result.headers.get('x-gateway-error-code'), expectedCode);
      assert.deepEqual(calls, { inference: 0, perception: 0, provider: 0 });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

for (const route of ['chat', 'responses', 'anthropic']) {
  await exercise({ route, expectedStatus: 400, expectedCode: 'gateway_image_input_unsupported' });
  await exercise({ route, fallback: true, legacyDelegate: true, expectedStatus: 400, expectedCode: 'gateway_image_input_unsupported' });
}
await exercise({ model: visionModel, expectedStatus: 200 });
await exercise({ model: visionModel, provider: 'unverified-provider', expectedStatus: 400, expectedCode: 'gateway_image_provider_unsupported' });
await exercise({ model: visionModel, bindPerception: false, expectedStatus: 503, expectedCode: 'gateway_perception_center_unavailable' });
console.log('Only declared native vision models reach Perception; text models cannot gain vision through fallback or retired config.');
