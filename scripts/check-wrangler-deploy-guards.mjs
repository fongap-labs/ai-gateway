#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Five-Worker production deployment guard regression (no Wrangler calls).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDeployTarget } from './wrangler-deploy-guards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = 'a'.repeat(40);
const vars = {
  AIG_BUILD_SHA: sha,
  AIG_MODELS_CONFIG: '{}',
  AIG_POLICIES_CONFIG: '{}',
  AIG_TIER2_NODES_01: '[]',
};
const base = { workers_dev: false };
const inference = {
  ...base,
  name: 'ai-inference-center',
  main: path.join(root, 'src/inference/inference-center-entry.ts'),
  keep_vars: false,
  vars,
};
const generation = {
  ...base,
  name: 'ai-generation-center',
  main: path.join(root, 'src/generation/generation-center-entry.ts'),
  keep_vars: false,
  vars,
};
const perception = {
  ...base,
  name: 'ai-perception-center',
  main: path.join(root, 'src/perception/perception-center-entry.ts'),
  keep_vars: false,
  vars,
};
const operations = {
  ...base,
  name: 'ai-gateway-operations',
  main: 'operations/standalone.ts',
  vars: { AIG_BUILD_SHA: sha },
  triggers: { crons: [] },
  d1_databases: [{ binding: 'TOKEN_STATS_DB', database_name: 'ai-gateway-stats', database_id: '123e4567-e89b-42d3-a456-426614174000' }],
};
const gateway = {
  ...base,
  name: 'ai-gateway',
  main: path.join(root, 'src/index.ts'),
  keep_vars: false,
  triggers: { crons: ['0 3 * * *'] },
  vars: {
    AIG_BUILD_SHA: sha,
    AIG_INFERENCE_ACTIVE: 'true',
    AIG_PERCEPTION_ACTIVE: 'true',
    AIG_GENERATION_ACTIVE: 'true',
  },
  services: [
    { binding: 'AIG_INFERENCE_SERVICE', service: 'ai-inference-center' },
    { binding: 'AIG_PERCEPTION_SERVICE', service: 'ai-perception-center' },
    { binding: 'AIG_GENERATION_SERVICE', service: 'ai-generation-center' },
  ],
  kv_namespaces: [{ binding: 'TIER1_AFFINITY', id: 'test-kv-id' }],
  d1_databases: operations.d1_databases,
};
const detachedGateway = {
  ...gateway,
  main: path.join(root, 'apps/gateway/index.ts'),
  triggers: { crons: [] },
};
assert.equal(classifyDeployTarget(detachedGateway, root), 'gateway', 'Detached Gateway must remain deployable');

for (const [name, config] of Object.entries({ gateway, inference, perception, generation, operations })) {
  assert.equal(classifyDeployTarget(config, root), name, `${name} should be a recognized deployment target`);
}
assert.equal(classifyDeployTarget({ ...inference, main: 'src/inference/inference-center-entry.ts' }, root), 'inference');
assert.equal(classifyDeployTarget({ ...generation, main: 'src/generation/generation-center-entry.ts' }, root), 'generation');

function reject(config) {
  assert.equal(classifyDeployTarget(config, root), null, 'Unsafe Worker deployment must fail closed');
}
const copy = (value) => structuredClone(value);
reject({ ...gateway, name: 'uncontrolled' });
reject({ ...gateway, main: 'src/unaudited-entry.ts' });
reject({ ...gateway, workers_dev: true });
reject({ ...gateway, keep_vars: true });
reject({ ...gateway, triggers: { crons: [] } });
reject({ ...gateway, services: [] });
reject({ ...gateway, services: [{ binding: 'AIG_INFERENCE_SERVICE', service: 'ai-inference-center' }] });
reject({ ...gateway, vars: { ...gateway.vars, AIG_PERCEPTION_ACTIVE: 'false' } });
reject({ ...gateway, kv_namespaces: [] });
reject({ ...gateway, d1_databases: [] });
reject({ ...gateway, vars: { ...gateway.vars, AIG_ACCESS_KEY_AIR: 'not-a-worker-var' } });
reject({ ...gateway, vars: { ...gateway.vars, AIG_EDGE_CACHE_HMAC_KEY: 'not-a-worker-var' } });
reject({ ...gateway, vars: { ...gateway.vars, AIG_DEPLOY_HEALTH_KEY: 'not-a-worker-var' } });
reject({ ...gateway, vars: { ...gateway.vars, CLOUDFLARE_API_TOKEN: 'not-a-worker-var' } });
reject({ ...gateway, vars: { ...gateway.vars, AIG_TIER3_NODES_01: '[]' } });
reject({ ...gateway, vars: { ...gateway.vars, AIG_INFERENCE_ACTIVE: 'false' } });
reject({ ...gateway, vars: { ...gateway.vars, AIG_BUILD_SHA: 'main' } });
reject({ ...detachedGateway, triggers: { crons: ['0 3 * * *'] } });
reject({ ...generation, vars: { ...vars, AIG_ACCESS_KEY_AIR: 'not-a-center-var' } });
reject({ ...gateway, vars: { ...gateway.vars, OPENAI_API_KEY: 'not-a-gateway-var' } });
reject({ ...inference, vars: { ...vars, OPENAI_API_KEY: 'not-a-center-var' } });
reject({ ...generation, vars: { ...vars, GEMINI_API_KEY: 'not-a-center-var' } });
reject({ ...inference, vars: { ...vars, PROVIDER_ACCESS_TOKEN: 'not-a-center-var' } });
assert.equal(
  classifyDeployTarget({ ...gateway, vars: { ...gateway.vars, AIG_TOKEN_D1_SAMPLE_PCT: '5' } }, root),
  'gateway',
  'Normal non-credential Token accounting configuration must remain valid',
);
reject({ ...inference, name: 'ai-gateway' });
reject({ ...generation, main: 'apps/generation/index.ts' });
reject({ ...generation, routes: [{ pattern: 'public.example.invalid' }] });
reject({ ...generation, workers_dev: true });
reject({ ...perception, workers_dev: true });
reject({ ...perception, services: [] });
reject({ ...perception, main: 'apps/perception/unapproved-entry.ts' });
reject({ ...generation, triggers: { crons: [] } });
reject({ ...generation, d1_databases: operations.d1_databases });
reject({ ...generation, vars: { ...vars, AIG_TIER3_NODES_01: '[]' } });
reject({ ...inference, vars: { ...vars, AIG_TIER2_CREDENTIALS_01: 'provider-secret' } });
reject({ ...inference, vars: { ...vars, AIG_INFERENCE_AUTH_KEY: 'private-secret' } });
reject({ ...inference, keep_vars: true });
reject({ ...inference, services: [] });
reject({ ...inference, main: 'src/inference/unapproved-entry.ts' });
reject({ ...operations, triggers: { crons: ['0 3 * * *'] } });
reject({ ...operations, d1_databases: [] });
reject({ ...operations, vars: {} });
reject({ ...operations, vars: { AIG_BUILD_SHA: 'main' } });
reject({ ...operations, vars: { ...operations.vars, AIG_TIER1_NODES_01: '[]' } });
reject({ ...operations, vars: { ...operations.vars, AIG_TIER1_CREDENTIALS_01: 'provider-secret' } });
reject({ ...operations, services: [] });
reject({ ...operations, custom_domains: ['public.example.invalid'] });
const wrongDb = copy(operations);
wrongDb.d1_databases[0].binding = 'DIFFERENT_DB';
reject(wrongDb);

const wrapper = readFileSync(new URL('./cloudflare-wrangler.mjs', import.meta.url), 'utf8');
assert.match(wrapper, /classifyDeployTarget\(config, root\)/, 'Production Wrangler wrapper must enforce the target allowlist');
assert.match(wrapper, /target !== 'operations'/, 'Operations preparation must never rerun Gateway D1 schema migrations');

console.log('Five-Worker Wrangler deploy allowlist passed: Gateway, three private centers, Operations and negative guards.');
