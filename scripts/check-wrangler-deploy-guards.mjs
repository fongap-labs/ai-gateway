#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Four-Worker production deployment guard regression (no Wrangler calls).
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
const operations = {
  ...base,
  name: 'ai-gateway-operations',
  main: 'operations/standalone.ts',
  triggers: { crons: [] },
  d1_databases: [
    { binding: 'TOKEN_STATS_DB', database_name: 'ai-gateway-stats', database_id: '123e4567-e89b-42d3-a456-426614174000' },
  ],
};
const gateway = { name: 'ai-gateway', kv_namespaces: [{ binding: 'TIER1_AFFINITY', id: 'test-kv-id' }] };

for (const [name, config] of Object.entries({ gateway, inference, generation, operations })) {
  assert.equal(classifyDeployTarget(config, root), name, name + ' should be a recognized deployment target');
}

function reject(config) {
  assert.equal(classifyDeployTarget(config, root), null, 'Unsafe Worker deployment must fail closed');
}
const copy = (value) => structuredClone(value);
reject({ ...gateway, name: 'uncontrolled' });
reject({ ...inference, name: 'ai-gateway' });
reject({ ...generation, main: 'apps/generation/index.ts' });
reject({ ...generation, routes: [{ pattern: 'public.example.invalid' }] });
reject({ ...generation, workers_dev: true });
reject({ ...generation, triggers: { crons: [] } });
reject({ ...generation, d1_databases: operations.d1_databases });
reject({ ...generation, vars: { ...vars, AIG_TIER3_NODES_01: '[]' } });
reject({ ...inference, vars: { ...vars, AIG_TIER2_CREDENTIALS_01: 'provider-secret' } });
reject({ ...inference, vars: { ...vars, AIG_INFERENCE_AUTH_KEY: 'private-secret' } });
reject({ ...inference, keep_vars: true });
reject({ ...inference, services: [] });
reject({ ...inference, main: 'src/inference/inference-center-entry.ts' });
reject({ ...operations, triggers: { crons: ['0 3 * * *'] } });
reject({ ...operations, d1_databases: [] });
reject({ ...operations, vars: {} });
reject({ ...operations, services: [] });
reject({ ...operations, custom_domains: ['public.example.invalid'] });
const wrongDb = copy(operations);
wrongDb.d1_databases[0].binding = 'DIFFERENT_DB';
reject(wrongDb);


const wrapper = readFileSync(new URL('./cloudflare-wrangler.mjs', import.meta.url), 'utf8');
assert.match(wrapper, /classifyDeployTarget\(config, root\)/, 'Production Wrangler wrapper must enforce the target allowlist');
assert.match(wrapper, /target !== 'operations'/, 'Operations preparation must never rerun Gateway D1 schema migrations');

console.log('Four-Worker Wrangler deploy allowlist passed: Gateway, private centers, staging Operations and negative guards.');
