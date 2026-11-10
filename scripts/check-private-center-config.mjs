#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { buildPrivateCenterConfig, verifyPrivateCenterSecretNames } from './private-center-config.mjs';
import { classifyDeployTarget } from './wrangler-deploy-guards.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  DEPLOY_SOURCE_SHA: 'a'.repeat(40),
  AIG_MODELS_CONFIG: '{}',
  AIG_POLICIES_CONFIG: '{}',
  AIG_TIER1_NODES_01: JSON.stringify([
    { id: 'text-01', provider: 'openai', base_url: 'https://provider.example.test/v1', models: { chat: 'physical-text' } },
    { id: 'image-01', provider: 'openai-image', base_url: 'https://provider.example.test/v1', models: { image: 'physical-image' } },
  ]),
  AIG_TIER2_NODES_01: JSON.stringify([
    { id: 'text-02', provider: 'anthropic', base_url: 'https://provider.example.test', models: { coding: 'physical-code' } },
  ]),
};
const inference = buildPrivateCenterConfig('ai-inference-center', env);
const generation = buildPrivateCenterConfig('ai-generation-center', env);
assert.equal(inference.nodeCount, 2);
assert.deepEqual(inference.tiers, ['1', '2']);
assert.equal(generation.nodeCount, 1);
assert.deepEqual(generation.tiers, ['1']);
assert.equal(classifyDeployTarget(inference.config, root), 'inference');
assert.equal(classifyDeployTarget(generation.config, root), 'generation');
assert.deepEqual(JSON.parse(inference.config.vars.AIG_TIER1_NODES_01).map(n => n.id), ['text-01']);
assert.equal(inference.config.vars.AIG_TIER2_NODES_01 !== undefined, true);
assert.deepEqual(JSON.parse(generation.config.vars.AIG_TIER1_NODES_01).map(n => n.id), ['image-01']);
assert.equal(generation.config.vars.AIG_TIER2_NODES_01, undefined);
for (const config of [inference.config, generation.config]) {
  assert.equal(config.workers_dev, false);
  assert.equal(config.keep_vars, false);
  for (const forbidden of ['routes', 'route', 'custom_domains', 'services', 'triggers', 'secrets', 'assets']) {
    assert.equal(Object.hasOwn(config, forbidden), false);
  }
  assert.equal(config.vars.AIG_BUILD_SHA, env.DEPLOY_SOURCE_SHA);
  assert.ok(!JSON.stringify(config).includes('provider-secret-value'));
}
const auth = (name) => ({ name, type: 'secret_text' });
assert.deepEqual(verifyPrivateCenterSecretNames('ai-inference-center', [
  auth('AIG_INFERENCE_AUTH_KEY'), auth('AIG_TIER1_CREDENTIALS_01'), auth('AIG_TIER2_CREDENTIALS_02')
], inference.tiers), { worker: 'ai-inference-center', secretNames: 3, tierCount: 2 });
assert.deepEqual(verifyPrivateCenterSecretNames('ai-generation-center', [
  auth('AIG_GENERATION_AUTH_KEY'), auth('AIG_TIER1_CREDENTIALS_01')
], generation.tiers), { worker: 'ai-generation-center', secretNames: 2, tierCount: 1 });
for (const [name, environment, pattern] of [
  ['ai-gateway', env, /Unknown private Worker/],
  ['ai-inference-center', { ...env, AIG_TOKEN_ENCRYPTION_KEY: 'legacy' }, /Forbidden Secret or retired Variable/],
  ['ai-generation-center', { ...env, AIG_TIER3_NODES_01: '[]' }, /Forbidden Secret or retired Variable/],
  ['ai-inference-center', { ...env, AIG_TIER1_CREDENTIALS_01: 'credential' }, /Forbidden Secret or retired Variable/],
  ['ai-inference-center', { ...env, AIG_TIER1_NODES_01: '[{"auth":"oauth"}]' }, /embedded-credential node/],
  ['ai-generation-center', { ...env, AIG_TIER1_NODES_01: '[]' }, /no eligible node/],
  ['ai-inference-center', { ...env, DEPLOY_SOURCE_SHA: 'main' }, /immutable 40-digit/],
]) assert.throws(() => buildPrivateCenterConfig(name, environment), pattern);
for (const [worker, inventory, tiers, pattern] of [
  ['ai-inference-center', [auth('AIG_GENERATION_AUTH_KEY')], ['1'], /outside its ownership/],
  ['ai-inference-center', [auth('AIG_INFERENCE_AUTH_KEY')], ['1'], /lacks Tier/],
  ['ai-generation-center', [auth('AIG_GENERATION_AUTH_KEY'), auth('AIG_TIER3_CREDENTIALS_01')], ['1'], /outside its ownership/],
  ['ai-generation-center', [auth('AIG_GENERATION_AUTH_KEY'), auth('AIG_TIER1_CREDENTIALS_01'), auth('AIG_TIER1_CREDENTIALS_01')], ['1'], /Duplicate/],
]) assert.throws(() => verifyPrivateCenterSecretNames(worker, inventory, tiers), pattern);

console.log('Private center config & Secret name guards passed; no Cloudflare requests or production writes.');
