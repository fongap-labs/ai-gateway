#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Contract tests for the offline five-Worker release preflight.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProductionReleasePreflight, RELEASE_PHASE_ORDER } from './production-release-preflight.mjs';
import { classifyDeployTarget } from './wrangler-deploy-guards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'a'.repeat(40);
const DB_ID = '123e4567-e89b-42d3-a456-426614174000';
const TEST_MODEL = 'release-contract-model';
const TEST_UPSTREAM = 'mock-upstream-model';
const CRON = '0 3 * * *';
const db = { binding: 'TOKEN_STATS_DB', database_name: 'mock-stats-db', database_id: DB_ID };
const nodeShard = JSON.stringify([{ id: 'mock-node', provider: 'mock-provider', models: { [TEST_MODEL]: TEST_UPSTREAM } }]);
const gateway = {
  name: 'ai-gateway',
  main: 'src/index.ts',
  compatibility_date: '2026-08-06',
  workers_dev: false,
  keep_vars: false,
  vars: {
    AIG_BUILD_SHA: SHA,
    AIG_INFERENCE_ACTIVE: 'true',
    AIG_PERCEPTION_ACTIVE: 'true',
    AIG_GENERATION_ACTIVE: 'true',
    AIG_TIER1_NODES_01: nodeShard,
  },
  services: [
    { binding: 'AIG_INFERENCE_SERVICE', service: 'ai-inference-center' },
    { binding: 'AIG_PERCEPTION_SERVICE', service: 'ai-perception-center' },
    { binding: 'AIG_GENERATION_SERVICE', service: 'ai-generation-center' },
  ],
  triggers: { crons: [CRON] },
  d1_databases: [{ ...db }],
  kv_namespaces: [{ binding: 'TIER1_AFFINITY', id: 'mock-tier1-kv' }],
};
const centerVars = {
  AIG_BUILD_SHA: SHA,
  AIG_MODELS_CONFIG: '{}',
  AIG_POLICIES_CONFIG: '{}',
  AIG_TIER1_NODES_01: nodeShard,
};
const inference = {
  name: 'ai-inference-center',
  main: path.join(ROOT, 'src/inference/inference-center-entry.ts'),
  workers_dev: false,
  keep_vars: false,
  vars: { ...centerVars },
};
const generation = {
  name: 'ai-generation-center',
  main: path.join(ROOT, 'src/generation/generation-center-entry.ts'),
  workers_dev: false,
  keep_vars: false,
  vars: { ...centerVars },
};
const perception = {
  name: 'ai-perception-center',
  main: path.join(ROOT, 'apps/perception/index.ts'),
  workers_dev: false,
  keep_vars: false,
  vars: { ...centerVars },
};
const operations = {
  name: 'ai-gateway-operations',
  main: 'operations/standalone.ts',
  compatibility_date: '2026-08-06',
  workers_dev: false,
  vars: { AIG_BUILD_SHA: SHA },
  triggers: { crons: [] },
  d1_databases: [{ ...db }],
};
const secretNames = {
  gateway: ['AIG_ACCESS_KEY_AIR', 'AIG_INFERENCE_AUTH_KEY', 'AIG_PERCEPTION_AUTH_KEY', 'AIG_GENERATION_AUTH_KEY'],
  inference: ['AIG_INFERENCE_AUTH_KEY', 'AIG_TIER1_CREDENTIALS_01'],
  perception: ['AIG_PERCEPTION_AUTH_KEY', 'AIG_TIER1_CREDENTIALS_01'],
  generation: ['AIG_GENERATION_AUTH_KEY', 'AIG_TIER1_CREDENTIALS_01'],
  operations: [],
};

function topology(stage) {
  const detached = stage !== 'prepare';
  return {
    source_sha: SHA,
    approved_for_production: false,
    stage,
    gateway: {
      ...structuredClone(gateway),
      ...(detached ? { main: 'apps/gateway/index.ts', triggers: { crons: [] } } : {}),
    },
    inference: structuredClone(inference),
    perception: structuredClone(perception),
    generation: structuredClone(generation),
    operations: {
      ...structuredClone(operations),
      triggers: { crons: stage === 'activate' ? [CRON] : [] },
    },
    secret_names: structuredClone(secretNames),
  };
}

const baseline = {
  phases: Object.fromEntries(RELEASE_PHASE_ORDER.map((stage) => [stage, topology(stage)])),
};
const report = assertProductionReleasePreflight(structuredClone(baseline));
assert.equal(report.ready_for_protected_review, true);
assert.equal(report.production_deployment_authorized, false);
assert.equal(report.provider_secret_values_verified, false);
assert.equal(report.global_cron_propagation_verified, false);
assert.deepEqual(report.phase_order, ['prepare', 'detach', 'activate']);
assert.deepEqual(
  report.phases.map((phase) => phase.cron_owner),
  ['prepare', 'detach', 'activate'],
);
assert.deepEqual(report.phases[0]?.wrangler_deploy_targets, ['gateway', 'inference', 'perception', 'generation', 'operations']);
assert.deepEqual(report.phases[2]?.wrangler_deploy_targets, ['gateway', 'inference', 'perception', 'generation']);
assert.equal(
  classifyDeployTarget(baseline.phases.activate.operations, ROOT),
  null,
  'Operations activation must use Cron control, not ordinary Wrangler deploy',
);
assert.ok(!JSON.stringify(report).includes(DB_ID));
assert.ok(!JSON.stringify(report).includes(TEST_MODEL));
assert.ok(!JSON.stringify(report).includes(TEST_UPSTREAM));
assert.ok(!JSON.stringify(report).includes('AIG_INFERENCE_AUTH_KEY'));

function rejected(change, kind) {
  const input = structuredClone(baseline);
  change(input);
  assert.throws(() => assertProductionReleasePreflight(input), undefined, kind);
}

rejected((p) => (p.phases.prepare.approved_for_production = true), 'Offline preflight must never authorize deployment');
rejected((p) => (p.phases.activate.operations.vars.AIG_BUILD_SHA = 'b'.repeat(40)), 'All five Worker build SHAs must match');
rejected((p) => (p.phases.detach.generation.vars.AIG_BUILD_SHA = 'b'.repeat(40)), 'Private center SHAs must match');
rejected((p) => (p.phases.prepare.gateway.services[1].service = 'unapproved-service'), 'All private service bindings are mandatory');
rejected((p) => (p.phases.prepare.gateway.kv_namespaces[0].binding = 'UNEXPECTED_KV'), 'Tier 1 KV identity is mandatory');
rejected((p) => p.phases.prepare.secret_names.gateway.push('OPENAI_API_KEY'), 'Gateway Provider Secret names are forbidden');
rejected((p) => p.phases.detach.secret_names.inference.push('OPENAI_API_KEY'), 'Inference must own only its auth and Provider credential names');
rejected((p) => p.phases.activate.secret_names.operations.push('AIG_TIER1_CREDENTIALS_01'), 'Operations cannot own credentials');
rejected(
  (p) => (p.phases.detach.operations.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000'),
  'Operations must share the exact Gateway D1',
);
rejected((p) => (p.phases.prepare.gateway.triggers.crons = []), 'Prepare must retain Gateway Cron ownership');
rejected((p) => (p.phases.detach.operations.triggers.crons = [CRON]), 'Detach must have zero Cron owners');
rejected((p) => (p.phases.activate.gateway.triggers.crons = [CRON]), 'Activate must not create two Cron owners');
rejected((p) => (p.phases.activate.inference.vars.AIG_MODELS_CONFIG = '{"changed":{}}'), 'Worker config must not drift between stages');
rejected((p) => p.phases.activate.secret_names.generation.push('AIG_EXTRA_SECRET'), 'Secret name inventory must not drift between stages');
rejected((p) => (p.phases.prepare.gateway.vars.AIG_BUILD_SHA = 'not-a-sha'), 'A full immutable SHA is required');

console.log(
  'Unified five-Worker release preflight passed: immutable SHA, Worker bindings, credential ownership, shared D1, staged Cron and deployment isolation.',
);
