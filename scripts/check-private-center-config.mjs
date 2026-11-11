#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModelFallbackPlan, modelFallbackCandidates } from '../apps/gateway/policy/model-fallback.ts';
import { getModelsConfigDiagnostics, loadModelsConfig } from '../src/config/models.ts';
import { getPolicy, isBuiltinPolicyName, loadPoliciesConfig } from '../src/config/policies.ts';
import { buildPrivateCenterConfig, preflightPrivateCenters, verifyPrivateCenterSecretNames } from './private-center-config.mjs';
import { classifyDeployTarget } from './wrangler-deploy-guards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  DEPLOY_SOURCE_SHA: 'a'.repeat(40),
  AIG_MODELS_CONFIG: JSON.stringify({ vision: { capabilities: { vision: true } } }),
  AIG_POLICIES_CONFIG: '{}',
  AIG_TIER1_NODES_01: JSON.stringify([
    { id: 'text-01', provider: 'openai', base_url: 'https://provider.example.test/v1', models: { chat: 'physical-text', vision: 'physical-vision' } },
    { id: 'image-01', provider: 'openai-image', base_url: 'https://provider.example.test/v1', models: { image: 'physical-image' } },
  ]),
  AIG_TIER2_NODES_01: JSON.stringify([
    { id: 'text-02', provider: 'anthropic', base_url: 'https://provider.example.test', models: { coding: 'physical-code' } },
  ]),
};
// Unknown model names do not imply a tier or fallback family.
const named = {
  'Write-Vivid': { policy: 'deep', fallback: ['Write-Basic'] },
  'Write-Basic': { policy: 'normal', fallback: ['Write-Vivid'] },
  Look: { policy: 'fast', fallback: [], capabilities: { vision: true }, modalities: { input: ['text', 'image'], output: ['text'] } },
};
const namedEnv = { AIG_MODELS_CONFIG: JSON.stringify(named) };
assert.deepEqual(getModelsConfigDiagnostics(namedEnv), []);
const namedModels = loadModelsConfig(namedEnv);
const names = new Set(['Write-Vivid', 'Write-Basic', 'Look']);
assert.deepEqual(modelFallbackCandidates('Write-Vivid', names, namedModels), ['Write-Vivid', 'Write-Basic']);
assert.deepEqual(
  buildModelFallbackPlan('Write-Vivid', names, 8, namedModels)[0].map((p) => p.model),
  ['Write-Vivid', 'Write-Basic'],
);
assert.deepEqual(modelFallbackCandidates('Write-Vivid', names), ['Write-Vivid'], 'No implicit model-name fallback');
assert.deepEqual(modelFallbackCandidates('Look', names, namedModels), ['Look']);
assert.ok(getModelsConfigDiagnostics({ AIG_MODELS_CONFIG: JSON.stringify({ X: { fallback: ['Y'] } }) }).some((e) => e.includes('not declared')));
assert.ok(getModelsConfigDiagnostics({ AIG_MODELS_CONFIG: JSON.stringify({ X: { fallback: ['X'] } }) }).some((e) => e.includes('cannot contain')));
assert.ok(
  getModelsConfigDiagnostics({ AIG_MODELS_CONFIG: JSON.stringify({ X: { fallback: ['Y', 'y'] }, Y: {} }) }).some((e) => e.includes('duplicate')),
);
const canonical = loadPoliciesConfig({});
assert.equal(canonical.fast.maxAttempts, 8);
assert.equal(canonical.normal.failoverBudgetMs, 120000);
assert.equal(canonical.deep.failoverBudgetMs, 180000);
assert.deepEqual(canonical.normal.hedge, { enabled: false });
assert.equal(getPolicy('Write-Vivid', namedModels, canonical).failoverBudgetMs, 180000);
assert.equal(getPolicy('Write-Basic', namedModels, canonical).failoverBudgetMs, 120000);
const withDeploySecret = buildPrivateCenterConfig('ai-inference-center', {
  ...env,
  AIG_DEPLOY_HEALTH_KEY: 'deployed-gateway-secret-must-not-enter-private-center',
  AIG_INFERENCE_AUTH_KEY: 'private-center-auth-kept-out-of-config',
});
assert.equal(Object.hasOwn(withDeploySecret.config.vars, 'AIG_DEPLOY_HEALTH_KEY'), false);
assert.equal(Object.hasOwn(withDeploySecret.config.vars, 'AIG_INFERENCE_AUTH_KEY'), false);
const inference = buildPrivateCenterConfig('ai-inference-center', env);
assert.deepEqual(preflightPrivateCenters(env), { workers: 3 });
// AIG_POLICIES_CONFIG is optional when models use the same built-in policies as the Gateway.
const withBuiltinPolicies = { ...env, AIG_POLICIES_CONFIG: '' };
assert.equal(preflightPrivateCenters(withBuiltinPolicies).workers, 3);
assert.equal(Object.hasOwn(buildPrivateCenterConfig('ai-inference-center', withBuiltinPolicies).config.vars, 'AIG_POLICIES_CONFIG'), false);
const customPolicyModels = JSON.stringify({
  chat: { policy: 'chat' },
  coding: { policy: 'coding' },
  vision: { capabilities: { vision: true } },
});
// chat and coding are built in; no operator-side policy Variable is needed.
const withNamedBuiltinPolicies = { ...env, AIG_MODELS_CONFIG: customPolicyModels, AIG_POLICIES_CONFIG: '' };
assert.equal(preflightPrivateCenters(withNamedBuiltinPolicies).workers, 3);
assert.equal(isBuiltinPolicyName('chat'), true);
assert.equal(isBuiltinPolicyName('coding'), true);
assert.equal(isBuiltinPolicyName('private'), false);
const defaultPolicies = loadPoliciesConfig({});
assert.equal(defaultPolicies.chat.maxAttempts, 8);
assert.deepEqual(defaultPolicies.chat.hedge, { enabled: false });
assert.equal(defaultPolicies.chat.tierAttempts, null, 'Tier 1 may consume all non-reserved attempts');
assert.equal(defaultPolicies.coding.maxAttempts, 8);
assert.deepEqual(defaultPolicies.coding.hedge, { enabled: false });
assert.equal(defaultPolicies.coding.tierAttempts, null, 'No artificial Tier 1 attempt quota');
assert.equal(getPolicy('Air', { Air: { policy: { policy: 'chat' } } }, defaultPolicies).maxAttempts, 8);
assert.equal(getPolicy('Code-Max', { 'Code-Max': { policy: { policy: 'coding' } } }, defaultPolicies).maxAttempts, 8);
// Explicit overrides take precedence, without changing any other built-in policy.
const overridden = loadPoliciesConfig({ AIG_POLICIES_CONFIG: '{"chat":{"max_attempts":2}}' });
assert.equal(overridden.chat.maxAttempts, 2);
assert.equal(overridden.coding.maxAttempts, 8);
assert.deepEqual(overridden.chat.hedge, { enabled: false });
const missingCustomPolicies = {
  ...withNamedBuiltinPolicies,
  AIG_MODELS_CONFIG: JSON.stringify({
    ...JSON.parse(customPolicyModels),
    specialist: { policy: 'private' },
  }),
};
assert.throws(() => preflightPrivateCenters(missingCustomPolicies), /missing definitions for referenced custom policies: private/);
const withCustomPolicies = { ...missingCustomPolicies, AIG_POLICIES_CONFIG: '{"private":{}}' };
assert.equal(preflightPrivateCenters(withCustomPolicies).workers, 3);
const noImageOrVision = {
  ...withCustomPolicies,
  AIG_MODELS_CONFIG: JSON.stringify({ chat: { policy: 'chat' }, coding: { policy: 'coding' } }),
  AIG_TIER1_NODES_01: JSON.stringify([
    { id: 'text-only', provider: 'openai', base_url: 'https://provider.example.test/v1', models: { chat: 'physical-text' } },
  ]),
};
assert.throws(
  () => preflightPrivateCenters(noImageOrVision),
  (error) => /ai-generation-center has no eligible node/.test(error.message) && /ai-perception-center has no eligible node/.test(error.message),
);
const generation = buildPrivateCenterConfig('ai-generation-center', env);
const perception = buildPrivateCenterConfig('ai-perception-center', env);
assert.equal(inference.nodeCount, 2);
assert.deepEqual(inference.tiers, ['1', '2']);
assert.equal(generation.nodeCount, 1);
assert.deepEqual(generation.tiers, ['1']);
assert.equal(perception.nodeCount, 1);
assert.deepEqual(perception.tiers, ['1']);
assert.equal(classifyDeployTarget(inference.config, root), 'inference');
assert.equal(classifyDeployTarget(generation.config, root), 'generation');
assert.equal(classifyDeployTarget(perception.config, root), 'perception');
assert.deepEqual(
  JSON.parse(inference.config.vars.AIG_TIER1_NODES_01).map((n) => n.id),
  ['text-01'],
);
assert.equal(inference.config.vars.AIG_TIER2_NODES_01 !== undefined, true);
assert.deepEqual(
  JSON.parse(generation.config.vars.AIG_TIER1_NODES_01).map((n) => n.id),
  ['image-01'],
);
assert.equal(generation.config.vars.AIG_TIER2_NODES_01, undefined);
assert.deepEqual(JSON.parse(perception.config.vars.AIG_TIER1_NODES_01)[0].models, { vision: 'physical-vision' });
assert.equal(perception.config.vars.AIG_TIER2_NODES_01, undefined);
for (const config of [inference.config, perception.config, generation.config]) {
  assert.equal(config.workers_dev, false);
  assert.equal(config.keep_vars, false);
  for (const forbidden of ['routes', 'route', 'custom_domains', 'services', 'triggers', 'secrets', 'assets']) {
    assert.equal(Object.hasOwn(config, forbidden), false);
  }
  assert.equal(config.vars.AIG_BUILD_SHA, env.DEPLOY_SOURCE_SHA);
  assert.ok(!JSON.stringify(config).includes('provider-secret-value'));
}
const auth = (name) => ({ name, type: 'secret_text' });
assert.deepEqual(
  verifyPrivateCenterSecretNames(
    'ai-inference-center',
    [auth('AIG_INFERENCE_AUTH_KEY'), auth('AIG_TIER1_CREDENTIALS_01'), auth('AIG_TIER2_CREDENTIALS_02')],
    inference.tiers,
  ),
  { worker: 'ai-inference-center', secretNames: 3, tierCount: 2 },
);
assert.deepEqual(
  verifyPrivateCenterSecretNames('ai-generation-center', [auth('AIG_GENERATION_AUTH_KEY'), auth('AIG_TIER1_CREDENTIALS_01')], generation.tiers),
  { worker: 'ai-generation-center', secretNames: 2, tierCount: 1 },
);
assert.deepEqual(
  verifyPrivateCenterSecretNames('ai-perception-center', [auth('AIG_PERCEPTION_AUTH_KEY'), auth('AIG_TIER1_CREDENTIALS_01')], perception.tiers),
  { worker: 'ai-perception-center', secretNames: 2, tierCount: 1 },
);
for (const [name, environment, pattern] of [
  ['ai-gateway', env, /Unknown private Worker/],
  ['ai-inference-center', { ...env, AIG_TOKEN_ENCRYPTION_KEY: 'legacy' }, /Forbidden Secret or retired Variable/],
  ['ai-generation-center', { ...env, AIG_TIER3_NODES_01: '[]' }, /Forbidden Secret or retired Variable/],
  [
    'ai-inference-center',
    { ...env, AIG_OPS_VARIABLES_JSON: JSON.stringify({ AIG_TIER1_CREDENTIALS_01: 'credential' }) },
    /Forbidden Secret or retired Variable/,
  ],
  ['ai-inference-center', { ...env, AIG_TIER1_NODES_01: '[{"auth":"oauth"}]' }, /embedded-credential node/],
  ['ai-generation-center', { ...env, AIG_TIER1_NODES_01: '[]' }, /no eligible node/],
  ['ai-perception-center', { ...env, AIG_MODELS_CONFIG: '{}' }, /no eligible node/],
  ['ai-inference-center', { ...env, DEPLOY_SOURCE_SHA: 'main' }, /immutable 40-digit/],
])
  assert.throws(() => buildPrivateCenterConfig(name, environment), pattern);
for (const [worker, inventory, tiers, pattern] of [
  ['ai-inference-center', [auth('AIG_GENERATION_AUTH_KEY')], ['1'], /outside its ownership/],
  ['ai-inference-center', [auth('AIG_INFERENCE_AUTH_KEY')], ['1'], /lacks Tier/],
  ['ai-generation-center', [auth('AIG_GENERATION_AUTH_KEY'), auth('AIG_TIER3_CREDENTIALS_01')], ['1'], /outside its ownership/],
  ['ai-generation-center', [auth('AIG_GENERATION_AUTH_KEY'), auth('AIG_TIER1_CREDENTIALS_01'), auth('AIG_TIER1_CREDENTIALS_01')], ['1'], /Duplicate/],
])
  assert.throws(() => verifyPrivateCenterSecretNames(worker, inventory, tiers), pattern);

const deployScript = readFileSync(path.join(root, 'scripts/deploy.sh'), 'utf8');
const script = (marker) => deployScript.indexOf(marker);
assert.ok(script('private-center-config.mjs preflight') >= 0, 'All centers must be checked before any deployment.');
assert.ok(script('private-center-config.mjs preflight') < script('persistent-deployment.mjs preflight'));
assert.ok(script('private-center-config.mjs prepare') >= 0, 'Both centers must be prepared.');
assert.ok(script('private-center-config.mjs verify-inventory') >= 0, 'Both Secret inventories must be checked.');
assert.ok(script('node scripts/deployment-recovery.mjs snapshot') > script('private-center-config.mjs prepare'));
assert.ok(script('node scripts/deployment-recovery.mjs snapshot') < script('node scripts/cloudflare-wrangler.mjs deploy'));
assert.ok(script('private-center-config.mjs verify-inventory') > script('node scripts/cloudflare-wrangler.mjs deploy'));
assert.ok(script('private-center-config.mjs verify-inventory') < script('node scripts/persistent-deployment.mjs verify-secrets'));
assert.ok(script('node scripts/persistent-deployment.mjs verify-secrets') < script('node scripts/deployment-recovery.mjs capture-published'));
assert.ok(deployScript.includes('action-worker:center:$center:$DEPLOY_SOURCE_SHA'));
assert.ok(!deployScript.includes('AIG_OPS_SECRET_VALUE'));
assert.ok(!deployScript.includes('wrangler secret put'));
console.log('Unified source deploy & private center config guards passed; offline only.');
