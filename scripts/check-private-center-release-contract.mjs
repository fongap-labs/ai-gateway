#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertReleaseTopology } from './check-private-center-release.mjs';

const sha = 'a'.repeat(40);
const db = { binding: 'TOKEN_STATS_DB', database_name: 'test-stats', database_id: '123e4567-e89b-42d3-a456-426614174000' };
const inferenceNodes = JSON.stringify([{ id: 'test-text', provider: 'openai', models: { 'Chat': 'gpt-4o' } }]);
const imageNodes = JSON.stringify([{ id: 'test-image', provider: 'openai-image', models: { 'Image': 'gpt-image-1' } }]);
const config = {
  source_sha: sha,
  approved_for_production: false,
  stage: 'prepare',
  gateway: {
    name: 'ai-gateway',
    main: 'src/index.ts',
    workers_dev: false,
    vars: { AIG_BUILD_SHA: sha, AIG_TIER1_NODES_01: inferenceNodes },
    services: [
      { binding: 'AIG_INFERENCE_SERVICE', service: 'ai-inference-center' },
      { binding: 'AIG_GENERATION_SERVICE', service: 'ai-generation-center' },
    ],
    triggers: { crons: ['0 3 * * *'] },
    d1_databases: [db],
  },
  inference: {
    name: 'ai-inference-center',
    main: 'src/inference/inference-center-entry.ts',
    workers_dev: false,
    vars: { AIG_BUILD_SHA: sha, AIG_TIER1_NODES_01: inferenceNodes },
  },
  generation: {
    name: 'ai-generation-center',
    main: 'src/generation/generation-center-entry.ts',
    workers_dev: false,
    vars: { AIG_BUILD_SHA: sha, AIG_TIER1_NODES_01: imageNodes },
  },
  operations: {
    name: 'ai-gateway-operations',
    main: 'operations/standalone.ts',
    workers_dev: false,
    triggers: { crons: [] },
    d1_databases: [db],
  },
  secret_names: {
    gateway: ['AIG_ACCESS_KEY_AIR', 'AIG_INFERENCE_AUTH_KEY', 'AIG_GENERATION_AUTH_KEY', 'AIG_DEPLOY_HEALTH_KEY'],
    inference: ['AIG_INFERENCE_AUTH_KEY', 'AIG_TIER1_CREDENTIALS_01'],
    generation: ['AIG_GENERATION_AUTH_KEY', 'AIG_TIER1_CREDENTIALS_01'],
  },
};
const copy = () => structuredClone(config);
assert.equal(assertReleaseTopology(copy()).ready, true);
for (const stage of ['detach', 'activate']) {
  const value = copy();
  value.stage = stage;
  value.gateway.main = 'apps/gateway/index.ts';
  value.gateway.triggers.crons = [];
  value.operations.triggers.crons = stage === 'activate' ? ['0 3 * * *'] : [];
  assert.equal(assertReleaseTopology(value).ready, true);
}
function reject(mutator) {
  const input = copy();
  mutator(input);
  assert.throws(() => assertReleaseTopology(input));
}
reject((p) => (p.approved_for_production = true));
reject((p) => (p.source_sha = 'main'));
reject((p) => (p.gateway.services = []));
reject((p) => (p.gateway.services[0].service = 'external'));
reject((p) => (p.gateway.services[1].binding = 'AIG_INFERENCE_SERVICE'));
reject((p) => (p.gateway.vars.AIG_TIER1_CREDENTIALS_01 = 'do-not-log'));
reject((p) => (p.gateway.vars.AIG_TOKEN_ENCRYPTION_KEY = 'do-not-log'));
reject((p) => p.secret_names.gateway.push('AIG_TIER1_CREDENTIALS_01'));
reject((p) => p.secret_names.inference.push('AIG_TIER3_CREDENTIALS_01'));
reject((p) => (p.secret_names.generation = []));
reject((p) => (p.inference.vars.AIG_BUILD_SHA = 'b'.repeat(40)));
reject((p) => (p.generation.vars.AIG_GENERATION_AUTH_KEY = 'never-public'));
reject((p) => (p.generation.routes = [{ pattern: 'public.example.invalid' }]));
reject((p) => (p.inference.workers_dev = true));
reject((p) => (p.operations.vars = { AIG_ACCESS_KEY_AIR: 'forbidden' }));
reject((p) => (p.operations.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000'));
reject((p) => (p.operations.triggers.crons = ['0 3 * * *']));
reject((p) => (p.gateway.triggers.crons = []));
reject((p) => (p.gateway.main = 'apps/gateway/index.ts'));
reject((p) => (p.inference.services = []));
reject((p) => (p.generation.triggers = { crons: [] }));
const deploy = JSON.parse(readFileSync(new URL('../.github/deploy.json', import.meta.url), 'utf8'));
assert.equal(deploy.automatic, false, 'Cutover must keep automatic production dispatch disabled');
console.log('Four-worker offline release gate passed: private centers, Secret names, SHA, D1 and one cron owner.');
