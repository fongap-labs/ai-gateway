#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Offline-only release contract. A second active cron before cutover would
// double-run D1 retention, so the candidate remains deliberately disabled.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scheduled, default as operations } from '../operations/standalone.ts';

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
console.log('Standalone Operations: isolated entry, no public route, disabled candidate cron, mandatory D1, no duplicate scheduling.');
