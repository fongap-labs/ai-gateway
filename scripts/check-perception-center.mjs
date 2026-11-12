#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Offline-only Perception release, binding, and privacy contract.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWranglerConfig } from './github-deployment-config.mjs';
import { validateDeploymentInputs, validateRemoteSecretInventory } from './persistent-deployment.mjs';
import { classifyDeployTarget } from './wrangler-deploy-guards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const base = JSON.parse(read('wrangler.perception-center.jsonc').replace(/^\s*\/\/.*$/gm, ''));
assert.equal(
  classifyDeployTarget(base, root),
  null,
  'The generated private Worker config must carry a validated runtime config before it is deploy-allowlisted.',
);
assert.equal(base.name, 'ai-perception-center');
assert.equal(base.main, 'apps/perception/index.ts');
assert.equal(base.workers_dev, false);
for (const field of ['routes', 'route', 'custom_domains', 'services', 'triggers', 'secrets', 'assets']) {
  assert.equal(Object.hasOwn(base, field), false, `Perception must not declare ${field}`);
}

const bound = buildWranglerConfig({
  AIG_INFERENCE_TARGET: 'ai-inference-center',
  AIG_PERCEPTION_TARGET: 'ai-perception-center',
  AIG_GENERATION_TARGET: 'ai-generation-center',
});
assert.deepEqual(bound.services, [
  { binding: 'AIG_INFERENCE_SERVICE', service: 'ai-inference-center' },
  { binding: 'AIG_PERCEPTION_SERVICE', service: 'ai-perception-center' },
  { binding: 'AIG_GENERATION_SERVICE', service: 'ai-generation-center' },
]);
assert.equal(bound.vars.AIG_PERCEPTION_ACTIVE, 'true');
assert.equal(Object.hasOwn(bound.vars, 'AIG_PERCEPTION_TARGET'), false);

const deploy = read('scripts/deploy.sh');
const centers = 'ai-inference-center ai-perception-center ai-generation-center';
assert.equal(
  (deploy.match(new RegExp(`for center in ${centers}`, 'g')) || []).length,
  3,
  'Prepare, deploy, and Secret-name inventory must cover every center in order.',
);
const prepare = deploy.indexOf('private-center-config.mjs prepare');
const snapshot = deploy.indexOf('deployment-recovery.mjs snapshot');
const centerDeploy = deploy.indexOf('action-worker:center:$center:$DEPLOY_SOURCE_SHA');
const inventory = deploy.indexOf('private-center-config.mjs verify-inventory');
const gatewayDeploy = deploy.indexOf('action-worker:deploy:$DEPLOY_SOURCE_SHA');
const providerPreflight = deploy.indexOf('sync_runtime_secrets preflight');
const reconcile = deploy.indexOf('sync_runtime_secrets reconcile');
assert.ok(prepare >= 0 && prepare < providerPreflight && providerPreflight < snapshot);
assert.ok(snapshot < centerDeploy && centerDeploy < reconcile && reconcile < inventory && inventory < gatewayDeploy);
assert.doesNotMatch(deploy, /wrangler secret put|--secrets-file|AIG_OPS_SECRET_VALUE/);

const source = read('apps/perception/index.ts');
assert.match(source, /AIG_PERCEPTION_AUTH_KEY/);
assert.match(source, /x-aig-perception-auth/);
assert.match(source, /executeNative\(request, env, invocation, \{ center: 'perception' \}\)/);
assert.doesNotMatch(source, /AIG_INFERENCE_AUTH_KEY|AIG_GENERATION_AUTH_KEY|\/internal\/health/);
const runtime = read('apps/inference/execution.ts');
assert.match(runtime, /options\.center === 'perception'/);
assert.match(runtime, /hasImageInput\(clientBody\)/);
assert.match(runtime, /getProviderProfile\(node\.provider\)\.imageInput/);
assert.match(runtime, /capabilities\.vision === true/);
assert.match(read('packages/contracts/provider-profiles.ts'), /imageInput: false/);

const env = {
  [`CLOUDFLARE_${['API', 'TOKEN'].join('_')}`]: 'local-contract-test-deploy-token',
  CLOUDFLARE_ACCOUNT_ID: 'local-contract-test-account',
  AIG_PUBLIC_URL: 'https://gateway.example.test',
  AIG_ACCESS_KEY_AIR: 'local-contract-test-access-key',
  AIG_AFFINITY_KV_ID: 'local-contract-test-kv',
  AIG_MODELS_CONFIG: JSON.stringify({ text: { policy: 'default' } }),
  AIG_POLICIES_CONFIG: '{}',
  AIG_TIER1_NODES_01: JSON.stringify([{ id: 'text', provider: 'openai', models: { text: 'physical-text' } }]),
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({ text: 'local-contract-test-provider-key' }),
  AIG_INFERENCE_TARGET: 'ai-inference-center',
  AIG_PERCEPTION_TARGET: 'ai-perception-center',
  AIG_GENERATION_TARGET: 'ai-generation-center',
  AIG_INFERENCE_AUTH_KEY: 'local-contract-test-inference-key-0123456789',
  AIG_PERCEPTION_AUTH_KEY: 'local-contract-test-perception-key-0123456789',
  AIG_GENERATION_AUTH_KEY: 'local-contract-test-generation-key-0123456789',
};
assert.throws(
  () =>
    validateRemoteSecretInventory(
      [
        { name: 'AIG_ACCESS_KEY_AIR', type: 'secret_text' },
        { name: 'AIG_INFERENCE_AUTH_KEY', type: 'secret_text' },
        { name: 'AIG_GENERATION_AUTH_KEY', type: 'secret_text' },
      ],
      bound,
    ),
  /AIG_PERCEPTION_AUTH_KEY/,
);
assert.throws(() => validateDeploymentInputs({ ...env, AIG_PERCEPTION_TARGET: 'untrusted-worker' }), /AIG_PERCEPTION_TARGET/);

assert.equal(JSON.parse(read('.github/deploy.json')).automatic, false);
console.log('Perception binding, bootstrap fail-closed behavior, private ingress, and source-deploy ordering passed offline.');
