#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Offline-only release contract. A second active cron before cutover would
// double-run D1 retention, so the candidate remains deliberately disabled.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { default as operations, scheduled } from '../operations/standalone.ts';
import { buildOperationsCutoverPhases, USAGE_MAINTENANCE_CRON } from './operations-cutover-config.mjs';

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const gateway = read('wrangler.jsonc');
const candidate = read('wrangler.operations.jsonc');
const build = read('wrangler.operations-build.jsonc');

assert.equal(candidate.name, 'ai-gateway-operations');
assert.equal(candidate.main, 'operations/standalone.ts');
assert.equal(candidate.workers_dev, false);
assert.equal(candidate.compatibility_date, gateway.compatibility_date);
assert.deepEqual(candidate.triggers.crons, [], 'Independent Operations cron must remain disabled before explicit cutover');
assert.equal(Object.hasOwn(candidate, 'd1_databases'), false, 'D1 binding must be supplied through an approved cutover');
for (const property of ['routes', 'route', 'services', 'vars', 'secrets', 'kv_namespaces', 'inherit']) {
  assert.equal(Object.hasOwn(candidate, property), false, `Staged Operations config must not contain ${property}`);
}
assert.equal(build.main, candidate.main);
assert.deepEqual(gateway.triggers.crons, ['0 3 * * *'], 'Original scheduled owner remains in place until cutover');
assert.equal(operations.scheduled, scheduled);
assert.equal(Object.hasOwn(operations, 'fetch'), false, 'Operations must not serve public HTTP requests');
await assert.rejects(scheduled({}, {}), /requires private TOKEN_STATS_DB D1 binding/);
const deploymentGateway = {
  ...gateway,
  vars: { AIG_TIER1_NODES_01: '[]' },
  d1_databases: [
    {
      binding: 'TOKEN_STATS_DB',
      database_name: 'ai-gateway-stats',
      database_id: '123e4567-e89b-42d3-a456-426614174000',
    },
  ],
};
const phases = buildOperationsCutoverPhases(deploymentGateway, candidate);
assert.deepEqual(phases.prepare.gateway.triggers.crons, [USAGE_MAINTENANCE_CRON]);
assert.deepEqual(phases.prepare.operations.triggers.crons, []);
assert.deepEqual(phases.detach.gateway.triggers.crons, []);
assert.deepEqual(phases.detach.operations.triggers.crons, []);
assert.deepEqual(phases.activate.gateway.triggers.crons, []);
assert.deepEqual(phases.activate.operations.triggers.crons, [USAGE_MAINTENANCE_CRON]);
assert.equal(phases.detach.gateway.main, 'apps/gateway/index.ts');
assert.equal(phases.activate.operations.d1_databases[0].database_id, deploymentGateway.d1_databases[0].database_id);
assert.equal(Object.hasOwn(phases.activate.operations, 'vars'), false, 'Operations must never inherit Gateway runtime variables');
assert.equal(Object.hasOwn(phases.activate.operations, 'services'), false, 'Operations must never inherit Provider Service Bindings');
assert.equal(Object.hasOwn(phases.activate.operations, 'secrets'), false, 'Operations must never inherit upstream Provider secrets');
assert.deepEqual(gateway.triggers.crons, [USAGE_MAINTENANCE_CRON], 'The planner cannot mutate live Gateway config');
assert.deepEqual(candidate.triggers.crons, [], 'The planner cannot activate the staged Operations manifest');
assert.throws(
  () => buildOperationsCutoverPhases({ ...deploymentGateway, d1_databases: [] }, candidate),
  /Exactly one existing Gateway D1 database/,
);
assert.throws(
  () => buildOperationsCutoverPhases(deploymentGateway, { ...candidate, triggers: { crons: [USAGE_MAINTENANCE_CRON] } }),
  /Candidate Operations cron must initially be disabled/,
);
assert.throws(
  () => buildOperationsCutoverPhases(deploymentGateway, { ...candidate, routes: [{ pattern: 'private.example.com' }] }),
  /Unsafe field in the staged Operations config: routes/,
);
assert.throws(
  () => buildOperationsCutoverPhases({ ...deploymentGateway, d1_databases: [{ ...deploymentGateway.d1_databases[0], binding: 'OTHER_DB' }] }, candidate),
  /TOKEN_STATS_DB/,
);
console.log('Standalone Operations: isolation, D1 ownership, staged three-phase cutover and zero double-Cron conditions passed.');
