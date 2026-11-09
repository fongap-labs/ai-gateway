#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Offline release gate: only generated Wrangler configs and Secret NAMES.
// No Cloudflare calls, Secret values, deployments, or mutations are permitted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRON = '0 3 * * *';
const SHA = /^[a-f0-9]{40}$/;
const NODE_SECRET = /^AIG_TIER[12]_CREDENTIALS_(0[1-9]|10)$/;
const LEGACY = /^(?:AIG_TIER3_|AIG_OAUTH_|AIG_IS_SUBSCRIPTION_ENABLED$|AIG_TOKEN_ENCRYPTION_KEY$)/;
const PUBLIC_SECRET = /^(?:AIG_TIER[12]_CREDENTIALS_|AIG_OAUTH_|AIG_TOKEN_ENCRYPTION_KEY$)/;

function record(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o);
}
function requireRecord(o, label) {
  assert.ok(record(o), label + ' must be an object');
}
function noPublicExposure(worker, label) {
  assert.equal(worker.workers_dev, false, label + ' must disable workers.dev');
  for (const key of ['routes', 'route', 'custom_domains', 'secrets', 'env']) {
    assert.equal(Object.hasOwn(worker, key), false, label + ' must not embed ' + key);
  }
}
function names(names, label) {
  assert.ok(Array.isArray(names) && names.every((n) => typeof n === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(n)), label + ' must contain Secret names only');
  assert.equal(new Set(names).size, names.length, label + ' contains duplicate Secret names');
  assert.ok(names.every((n) => !LEGACY.test(n)), label + ' contains retired Tier3 or OAuth bindings');
  return new Set(names);
}
function oneD1(worker, label) {
  const bindings = worker.d1_databases;
  assert.ok(Array.isArray(bindings) && bindings.length === 1, label + ' requires exactly one D1');
  const db = bindings[0];
  assert.ok(record(db) && db.binding === 'TOKEN_STATS_DB', label + ' must bind TOKEN_STATS_DB');
  assert.ok(typeof db.database_id === 'string' && /^(?:[0-9a-f]{32}|[0-9a-f-]{36})$/i.test(db.database_id), label + ' D1 id is invalid');
  return db.database_id;
}
function secretVars(config, label) {
  requireRecord(config.vars, label + ' vars');
  for (const key of Object.keys(config.vars)) {
    assert.equal(PUBLIC_SECRET.test(key) || LEGACY.test(key) || /(?:^|_)SECRET(?:_|$)/.test(key) || /(?:^|_)AUTH_KEY$/.test(key), false,
      label + ' exposes a credential variable name');
  }
}
function checkCenter(config, label, expectedName, expectedEntry, authName, sourceSha, namesSet) {
  requireRecord(config, label);
  noPublicExposure(config, label);
  assert.equal(config.name, expectedName, label + ' worker identity mismatch');
  assert.ok(typeof config.main === 'string' && config.main.endsWith(expectedEntry), label + ' entrypoint mismatch');
  assert.equal(Object.hasOwn(config, 'triggers'), false, label + ' must never own cron');
  assert.equal(Object.hasOwn(config, 'services'), false, label + ' must not route to another Worker');
  secretVars(config, label);
  assert.equal(config.vars.AIG_BUILD_SHA, sourceSha, label + ' build SHA differs from Gateway');
  assert.ok(namesSet.has(authName), label + ' internal auth Secret is absent');
  assert.ok([...namesSet].some((n) => NODE_SECRET.test(n)), label + ' has no static Token Secret shards');
  assert.ok(Object.keys(config.vars).some((n) => /^AIG_TIER[12]_NODES_(0[1-9]|10)$/.test(n)), label + ' has no declared node shards');
}
/**
 * Verify FINAL cutover topology or its explicit cron handoff stages.
 * Input contains only configuration metadata and Secret names. Real resource
 * IDs and node metadata must remain in the protected operator workspace.
 */
export function assertReleaseTopology(plan) {
  requireRecord(plan, 'release plan');
  const { source_sha: sha, gateway, inference, generation, operations, secret_names: inventory, stage } = plan;
  assert.ok(typeof sha === 'string' && SHA.test(sha), 'A full immutable source SHA is required');
  assert.ok(['prepare', 'detach', 'activate'].includes(stage), 'Unknown Operations cron handoff stage');
  for (const [label, config] of Object.entries({ gateway, inference, generation, operations })) requireRecord(config, label);
  requireRecord(inventory, 'secret_names');
  const gNames = names(inventory.gateway, 'Gateway');
  const iNames = names(inventory.inference, 'Inference');
  const pNames = names(inventory.generation, 'Generation');
  assert.ok([...gNames].every((n) => !NODE_SECRET.test(n)), 'Gateway must not own upstream Provider Token shards');
  assert.ok(gNames.has('AIG_INFERENCE_AUTH_KEY') && gNames.has('AIG_GENERATION_AUTH_KEY'), 'Gateway must hold both private center auth bindings');
  noPublicExposure(gateway, 'Gateway');
  assert.equal(gateway.name, 'ai-gateway');
  assert.equal(gateway.vars?.AIG_BUILD_SHA, sha, 'Gateway build SHA mismatch');
  secretVars(gateway, 'Gateway');
  assert.deepEqual(
    gateway.services,
    [
      { binding: 'AIG_INFERENCE_SERVICE', service: 'ai-inference-center' },
      { binding: 'AIG_GENERATION_SERVICE', service: 'ai-generation-center' },
    ],
    'Gateway must route to both private centers through exact Service Bindings',
  );
  checkCenter(inference, 'Inference', 'ai-inference-center', 'src/inference/inference-center-entry.ts', 'AIG_INFERENCE_AUTH_KEY', sha, iNames);
  checkCenter(generation, 'Generation', 'ai-generation-center', 'src/generation/generation-center-entry.ts', 'AIG_GENERATION_AUTH_KEY', sha, pNames);
  assert.equal(Object.hasOwn(generation, 'd1_databases'), false, 'Generation must not inherit a usage D1');
  assert.equal(Object.hasOwn(generation, 'kv_namespaces'), false, 'Generation must not inherit Gateway KV');
  const gatewayDb = oneD1(gateway, 'Gateway');
  if (Object.hasOwn(inference, 'd1_databases')) assert.equal(oneD1(inference, 'Inference'), gatewayDb, 'Inference D1 identity mismatch');
  noPublicExposure(operations, 'Operations');
  assert.equal(operations.name, 'ai-gateway-operations');
  assert.ok(typeof operations.main === 'string' && operations.main.endsWith('operations/standalone.ts'), 'Operations must use standalone handler');
  assert.equal(Object.hasOwn(operations, 'fetch'), false, 'Operations must have no public fetch handler');
  assert.equal(Object.hasOwn(operations, 'services'), false, 'Operations must not inherit Gateway Services');
  assert.equal(Object.hasOwn(operations, 'vars'), false, 'Operations must not inherit Gateway vars');
  assert.equal(oneD1(operations, 'Operations'), gatewayDb, 'Operations D1 must equal Gateway D1');
  const oldCron = stage === 'prepare' ? [CRON] : [];
  const newCron = stage === 'activate' ? [CRON] : [];
  assert.deepEqual(gateway.triggers?.crons, oldCron, 'Gateway cron handoff mismatch');
  assert.deepEqual(operations.triggers?.crons, newCron, 'Operations cron handoff mismatch');
  assert.equal(
    stage === 'prepare' ? gateway.main.endsWith('src/index.ts') : gateway.main.endsWith('apps/gateway/index.ts'),
    true,
    'Gateway entrypoint must match cron handoff stage',
  );
  assert.equal(plan.approved_for_production, false, 'Offline readiness is never a production deployment approval');
  return { ready: true, stage, workers: 4, gates: ['private-centers', 'static-token-ownership', 'immutable-build', 'cron-single-owner', 'd1-equality'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: check-private-center-release.mjs FILE');
    const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const result = assertReleaseTopology(plan);
    process.stdout.write('Offline four-worker release topology passed (' + result.stage + '); no deployment authorized.\n');
  } catch {
    // Never echo the source text or any supplied Secret material.
    process.stderr.write('Offline four-worker release topology rejected; inspect private inputs and stage contracts.\n');
    process.exitCode = 2;
  }
}
