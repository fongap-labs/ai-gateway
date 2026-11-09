#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Offline-only, fail-closed production release preflight. It accepts generated
// Worker metadata and Secret names only; it never calls Cloudflare or deploys.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseTopology } from './check-private-center-release.mjs';
import { classifyCronOwnership } from './operations-cron-control.mjs';
import { buildOperationsCutoverPhases } from './operations-cutover-config.mjs';
import { classifyDeployTarget } from './wrangler-deploy-guards.mjs';

export const RELEASE_PHASE_ORDER = Object.freeze(['prepare', 'detach', 'activate']);
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function removeKeys(value, keys) {
  const result = structuredClone(value);
  for (const key of keys) delete result[key];
  return result;
}

function comparePhaseInvariant(phase) {
  return {
    source_sha: phase.source_sha,
    gateway: removeKeys(phase.gateway, ['main', 'triggers']),
    inference: phase.inference,
    generation: phase.generation,
    operations: removeKeys(phase.operations, ['triggers']),
    secret_names: phase.secret_names,
  };
}

function expectedCronOwner(phase) {
  const owner = classifyCronOwnership({
    gateway: phase.gateway.triggers?.crons,
    operations: phase.operations.triggers?.crons,
  });
  assert.equal(owner, phase.stage, `${phase.stage} Cron owner does not match its stage`);
  return owner;
}

function checkDeployAllowlist(phase, index) {
  const expected = ['gateway', 'inference', 'generation'];
  if (index < RELEASE_PHASE_ORDER.length - 1) expected.push('operations');
  for (const worker of expected) {
    assert.equal(classifyDeployTarget(phase[worker], ROOT), worker, `${phase.stage} ${worker} is not deploy-allowlisted`);
  }
  if (phase.stage === 'activate') {
    assert.equal(
      classifyDeployTarget(phase.operations, ROOT),
      null,
      'Activated Operations Cron must not be applied through the ordinary Wrangler deploy path',
    );
  }
}

function compareOperationsPlanner(preparePhase, phases) {
  const candidate = structuredClone(preparePhase.operations);
  delete candidate.vars;
  delete candidate.d1_databases;
  const generated = buildOperationsCutoverPhases(preparePhase.gateway, candidate);
  for (const stage of RELEASE_PHASE_ORDER) {
    assert.equal(
      stableJson(generated[stage].gateway),
      stableJson(phases[stage].gateway),
      `${stage} Gateway config differs from the existing Operations cutover planner`,
    );
    assert.equal(
      stableJson(generated[stage].operations),
      stableJson(phases[stage].operations),
      `${stage} Operations config differs from the existing Operations cutover planner`,
    );
  }
}

/**
 * Validate three complete offline topology snapshots in strict order. Passing
 * means ready for protected operator review only; it never authorizes deploy.
 */
export function assertProductionReleasePreflight(plan) {
  assert.ok(record(plan) && record(plan.phases), 'A three-stage release plan is required');
  assert.deepEqual(Object.keys(plan.phases), RELEASE_PHASE_ORDER, 'Phases must be ordered prepare → detach → activate');
  const deploy = JSON.parse(readFileSync(path.join(ROOT, '.github/deploy.json'), 'utf8'));
  assert.equal(deploy.automatic, false, 'Automatic production deployment must remain disabled');

  const phases = plan.phases;
  const prepared = phases.prepare;
  const sourceSha = prepared?.source_sha;
  assert.ok(typeof sourceSha === 'string' && SOURCE_SHA.test(sourceSha), 'A full immutable release SHA is required');

  const summary = [];
  for (const [index, stage] of RELEASE_PHASE_ORDER.entries()) {
    const phase = phases[stage];
    assert.ok(record(phase), `${stage} topology snapshot is required`);
    assert.equal(phase.stage, stage, `${stage} topology snapshot has the wrong stage label`);
    assert.equal(phase.source_sha, sourceSha, `${stage} source SHA differs from the release SHA`);
    assert.equal(phase.approved_for_production, false, `${stage} offline preflight cannot carry deployment approval`);
    const topology = assertReleaseTopology(phase);
    const cronOwner = expectedCronOwner(phase);
    checkDeployAllowlist(phase, index);
    summary.push({
      stage,
      workers: topology.workers,
      cron_owner: cronOwner,
      wrangler_deploy_targets:
        index < RELEASE_PHASE_ORDER.length - 1 ? ['gateway', 'inference', 'generation', 'operations'] : ['gateway', 'inference', 'generation'],
      requires_runtime_evidence_before_next_stage: true,
    });
  }

  const baseline = stableJson(comparePhaseInvariant(prepared));
  for (const stage of RELEASE_PHASE_ORDER.slice(1)) {
    assert.equal(
      stableJson(comparePhaseInvariant(phases[stage])),
      baseline,
      `${stage} changes immutable Worker, D1, Service Binding or Secret-name metadata between phases`,
    );
  }
  compareOperationsPlanner(prepared, phases);

  return {
    schema_version: 1,
    ready_for_protected_review: true,
    production_deployment_authorized: false,
    source_sha: sourceSha,
    phase_order: [...RELEASE_PHASE_ORDER],
    phases: summary,
    provider_secret_values_verified: false,
    global_cron_propagation_verified: false,
  };
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--plan') throw new Error('usage: production-release-preflight.mjs --plan FILE');
  const plan = JSON.parse(readFileSync(path.resolve(argv[1]), 'utf8'));
  const report = assertProductionReleasePreflight(plan);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch {
    // Source manifests may contain private operational metadata; never echo it.
    process.stderr.write('Offline production release preflight rejected; inspect protected inputs and stage requirements.\n');
    process.exitCode = 2;
  }
}
