#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Offline-only Operations cutover planner. It never authenticates to Cloudflare
// or performs a deployment. Output files contain production metadata and must
// remain private; this planner does not read or copy Provider Secret values.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE_MAINTENANCE_CRON = '0 3 * * *';
const SOURCE_SHA = /^[0-9a-f]{40}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function crons(config) {
  return config?.triggers?.crons;
}

function gatewayOnlyMain(main) {
  if (typeof main !== 'string' || !/(?:^|[\\/])src[\\/]index\.ts$/.test(main)) {
    throw new Error('Expected the existing composed Gateway source entry.');
  }
  return main.replace(/src[\\/]index\.ts$/, 'apps/gateway/index.ts');
}

function assertSingleOwner(gateway, operations, label) {
  const gatewayCrons = crons(gateway);
  const operationsCrons = crons(operations);
  assert.ok(Array.isArray(gatewayCrons) && Array.isArray(operationsCrons), `${label}: both cron lists are required`);
  const total = gatewayCrons.length + operationsCrons.length;
  assert.ok(total <= 1, `${label}: multiple active scheduled owners are forbidden`);
}

/**
 * Build a 3-step, never-double-cron migration from already prepared (non-secret)
 * Wrangler configs. The private Operations D1 binding must match the Gateway's
 * existing token-usage D1. No step is deployed by this function.
 */
export function buildOperationsCutoverPhases(gatewayConfig, operationsCandidate) {
  if (!isRecord(gatewayConfig) || !isRecord(operationsCandidate)) {
    throw new Error('Both generated Wrangler configurations are required.');
  }
  if (gatewayConfig.name !== 'ai-gateway' || operationsCandidate.name !== 'ai-gateway-operations') {
    throw new Error('Unexpected Gateway or Operations worker identity.');
  }
  if (gatewayConfig.compatibility_date !== operationsCandidate.compatibility_date) {
    throw new Error('Gateway and Operations compatibility dates differ.');
  }
  const gatewayMain = gatewayOnlyMain(gatewayConfig.main);
  const sourceSha = gatewayConfig.vars?.AIG_BUILD_SHA;
  if (typeof sourceSha !== 'string' || !SOURCE_SHA.test(sourceSha)) {
    throw new Error('Gateway release config must provide its immutable AIG_BUILD_SHA.');
  }
  if (operationsCandidate.main !== 'operations/standalone.ts') {
    throw new Error('Operations must use the fail-closed standalone entry.');
  }
  if (gatewayConfig.workers_dev !== false || operationsCandidate.workers_dev !== false) {
    throw new Error('Neither worker may expose workers.dev.');
  }
  if (Object.hasOwn(gatewayConfig, 'secrets')) {
    throw new Error('Source Gateway config must not embed Secret values.');
  }
  if (
    isRecord(gatewayConfig.vars) &&
    Object.keys(gatewayConfig.vars).some(
      (name) => /_CREDENTIALS_/.test(name) || name === 'AIG_EDGE_CACHE_HMAC_KEY' || name === 'AIG_TOKEN_ENCRYPTION_KEY',
    )
  ) {
    throw new Error('Source Gateway vars contain a prohibited Secret binding.');
  }
  if (JSON.stringify(crons(gatewayConfig)) !== JSON.stringify([USAGE_MAINTENANCE_CRON])) {
    throw new Error('Existing Gateway maintenance cron is not the expected single owner.');
  }
  if (JSON.stringify(crons(operationsCandidate)) !== '[]') {
    throw new Error('Candidate Operations cron must initially be disabled.');
  }
  for (const field of ['routes', 'route', 'services', 'vars', 'secrets', 'kv_namespaces', 'd1_databases', 'inherit']) {
    if (Object.hasOwn(operationsCandidate, field)) {
      throw new Error(`Unsafe field in the staged Operations config: ${field}`);
    }
  }

  const databases = gatewayConfig.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 1) {
    throw new Error('Exactly one existing Gateway D1 database is required.');
  }
  const currentDb = databases[0];
  if (!isRecord(currentDb) || currentDb.binding !== 'TOKEN_STATS_DB') {
    throw new Error('Existing Gateway usage D1 binding must be TOKEN_STATS_DB.');
  }
  if (
    typeof currentDb.database_id !== 'string' ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(currentDb.database_id) ||
    typeof currentDb.database_name !== 'string' ||
    !currentDb.database_name.trim()
  ) {
    throw new Error('Existing Gateway usage D1 identity is missing or invalid.');
  }
  // Do not export/print the actual D1 id; every phase uses the existing id.
  const operationsWithD1 = {
    ...operationsCandidate,
    // Carry only immutable build identity; never inherit Gateway runtime vars.
    vars: { AIG_BUILD_SHA: sourceSha },
    d1_databases: [
      {
        binding: 'TOKEN_STATS_DB',
        database_name: currentDb.database_name,
        database_id: currentDb.database_id,
      },
    ],
  };
  const gatewayWithoutCron = {
    ...gatewayConfig,
    main: gatewayMain,
    triggers: { ...gatewayConfig.triggers, crons: [] },
  };
  const operationsWithCron = {
    ...operationsWithD1,
    triggers: { ...operationsCandidate.triggers, crons: [USAGE_MAINTENANCE_CRON] },
  };
  const phases = {
    prepare: { gateway: gatewayConfig, operations: operationsWithD1 },
    detach: { gateway: gatewayWithoutCron, operations: operationsWithD1 },
    activate: { gateway: gatewayWithoutCron, operations: operationsWithCron },
  };
  for (const [name, pair] of Object.entries(phases)) assertSingleOwner(pair.gateway, pair.operations, name);
  if (phases.prepare.operations.triggers.crons.length !== 0 || phases.detach.operations.triggers.crons.length !== 0) {
    throw new Error('Operations must not activate before Gateway cron detaches.');
  }
  if (phases.activate.gateway.triggers.crons.length !== 0) throw new Error('Final Gateway cron must be disabled.');
  return phases;
}

function argsToObject(argv) {
  if (argv.length !== 6) {
    throw new Error('usage: operations-cutover-config.mjs --gateway FILE --operations FILE --outdir DIRECTORY');
  }
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--gateway', '--operations', '--outdir'].includes(flag) || result[flag] || !argv[i + 1]) {
      throw new Error('Invalid or duplicate cutover argument.');
    }
    result[flag] = argv[i + 1];
  }
  if (!result['--gateway'] || !result['--operations'] || !result['--outdir']) {
    throw new Error('Gateway, Operations and output directory are required.');
  }
  return result;
}

function readConfig(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid Wrangler JSON input; contents suppressed.');
  }
}

function writePlan(phases, outdir) {
  if (fs.existsSync(outdir)) throw new Error('Cutover output directory already exists; refusing overwrite.');
  fs.mkdirSync(outdir, { mode: 0o700, recursive: false });
  for (const [stage, entries] of Object.entries(phases)) {
    for (const [worker, config] of Object.entries(entries)) {
      fs.writeFileSync(path.join(outdir, `${stage}-${worker}.json`), `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argsToObject(process.argv.slice(2));
    const phases = buildOperationsCutoverPhases(readConfig(args['--gateway']), readConfig(args['--operations']));
    writePlan(phases, args['--outdir']);
    process.stdout.write('Wrote private three-phase Operations cutover plan (no deployment, no secrets, no double Cron).\n');
  } catch (error) {
    process.stderr.write(`Operations cutover planning failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 2;
  }
}
