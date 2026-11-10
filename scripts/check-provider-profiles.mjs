#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Provider routing metadata must match actual Provider adapters, including
// unknown/custom providers which use the generic OpenAI-compatible wire.
import assert from 'node:assert/strict';
import { getProviderProfile } from '../packages/contracts/provider-profiles.ts';
import { getProviderAdapter, providerWire } from '../src/providers/registry.ts';

for (const name of ['openai', 'anthropic', 'google', 'openai-image', 'google-image', 'cloudflare-image', 'unknown-custom-provider']) {
  const profile = getProviderProfile(name);
  const adapter = getProviderAdapter(name);
  assert.deepEqual(profile.wire, providerWire(name), `${name}: wire capabilities drifted`);
  assert.deepEqual(profile.wire, adapter.wire, `${name}: native adapter drifted`);
  assert.equal(profile.streamUsage, adapter.streamUsage, `${name}: usage streaming capability drifted`);
}
for (const [provider, acceptsImages] of [
  ['openai', true],
  ['anthropic', true],
  ['google', false],
  ['openai-image', false],
  ['google-image', false],
  ['cloudflare-image', false],
  ['unknown-custom-provider', false],
]) {
  assert.equal(getProviderProfile(provider).imageInput, acceptsImages, `${provider}: image-input routing must remain explicit`);
}
assert.deepEqual(getProviderProfile(' OPENAI '), getProviderProfile('openai'));
assert.deepEqual(getProviderProfile('unknown-custom-provider'), getProviderProfile('generic-openai'));
console.log('Credential-free Provider routing profiles match all real adapters.');
