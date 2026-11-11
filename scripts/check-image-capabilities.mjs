#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Image capability metadata must not drift from real Provider adapters.
import assert from 'node:assert/strict';
import { canRouteImageGeneration, IMAGE_PROVIDER_IDS, isImageGenerationProvider } from '../packages/contracts/image-capabilities.ts';
import { getProviderAdapter } from '../src/providers/registry.ts';

const sizes = ['1024x1024', '1024x1536', '1536x1024'];
const models = ['gpt-image-1', '@cf/black-forest-labs/flux-1-schnell', '@cf/INVALID/model'];
for (const provider of IMAGE_PROVIDER_IDS) {
  const adapter = getProviderAdapter(provider).image;
  assert.ok(adapter, `Adapter missing for declared image provider ${provider}`);
  assert.ok(isImageGenerationProvider(provider));
  for (const size of sizes) {
    for (const physical of models) {
      const node = {
        provider,
        baseUrl: 'https://provider.example/v1',
        surfaces: ['images_generations'],
        models: { 'image-test': physical },
      };
      const expected = adapter.prepare(node.baseUrl, physical, { prompt: 'test', size }) !== null;
      assert.equal(canRouteImageGeneration(node, 'image-test', size), expected, `${provider}/${physical}/${size}`);
    }
  }
}
const native = {
  provider: 'openai-image',
  baseUrl: 'https://provider.example/v1',
  surfaces: ['images_generations'],
  models: { 'image-test': 'gpt-image-1' },
};
assert.equal(isImageGenerationProvider(' OpenAI-Image '), true);
assert.equal(canRouteImageGeneration({ ...native, provider: ' OpenAI-Image ' }, 'image-test', '1024x1024'), true);
const normalizedCloudflare = {
  ...native,
  provider: ' CLOUDFLARE-IMAGE ',
  models: { 'image-test': '@cf/black-forest-labs/flux-1-schnell' },
};
assert.equal(canRouteImageGeneration(normalizedCloudflare, 'image-test', '1024x1024'), true);
assert.equal(canRouteImageGeneration(normalizedCloudflare, 'image-test', '1024x1536'), false);
assert.equal(canRouteImageGeneration({ ...native, auth: 'oauth' }, 'image-test', '1024x1024'), false);
assert.equal(canRouteImageGeneration({ ...native, surfaces: ['chat_completions'] }, 'image-test', '1024x1024'), false);
assert.equal(canRouteImageGeneration({ ...native, models: {} }, 'image-test', '1024x1024'), false);
assert.equal(canRouteImageGeneration({ ...native, baseUrl: ':invalid:' }, 'image-test', '1024x1024'), false);
assert.equal(canRouteImageGeneration(native, 'image-test', 'invalid-size'), false);
assert.equal(canRouteImageGeneration({ ...native, provider: 'openai' }, 'image-test', '1024x1024'), false);
assert.equal(isImageGenerationProvider('generic-openai'), false);
console.log('Image capability declarations match native adapters and fail closed on unsupported nodes.');
