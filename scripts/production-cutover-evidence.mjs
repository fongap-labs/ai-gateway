#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Read-only bridge between protected Cloudflare metadata and the offline
// three-stage release plan. This module never approves or deploys anything.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKERS = ['ai-gateway', 'ai-inference-center', 'ai-generation-center', 'ai-gateway-operations'];
const PHASES = ['prepare', 'detach', 'activate'];
const CRON = '0 3 * * *';
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const REQUIRED_UNVERIFIED = [
  'provider-secret-values-and-credential-functionality',
  'node-json-oauth-markers-and-migration-conflicts',
  'four-worker-build-sha-equality',
  'runtime-health-and-request-metrics',
  'global-cron-propagation-and-independent-runtime-evidence',
  'rollback-drill',
];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cronFor(phase, workerName) {
  if (workerName === 'ai-gateway') return phase === 'prepare' ? [CRON] : [];
  if (workerName === 'ai-gateway-operations') return phase === 'activate' ? [CRON] : [];
  return [];
}

/**
 * Correlate two independently generated, non-secret artifacts. A passing
 * result is metadata readiness for protected runtime verification, never a
 * deployment or cutover authorization.
 */
export function assertReadOnlyCutoverEvidence(inventory, preflight, phase) {
  assert.ok(PHASES.includes(phase), 'Expected one of the three cutover phases');
  assert.ok(record(inventory) && record(preflight), 'Both independent evidence reports are required');
  assert.equal(inventory.report_type, 'cloudflare_read_only_inventory', 'Only the protected inventory report is accepted');
  assert.equal(inventory.production_cutover_approved, false, 'Inventory must not claim release approval');
  assert.equal(inventory.access_requirement?.secret_values_requested_or_reported, false, 'Inventory must not contain Secret values');
  assert.equal(inventory.metadata_consistency, 'pass', 'Live Cloudflare metadata must pass its own checks');
  assert.deepEqual(inventory.blockers, [], 'Live Cloudflare metadata still contains blockers');
  assert.equal(inventory.cron_phase, phase, 'Live Cron phase differs from the release plan');
  assert.ok(record(inventory.workers) && record(inventory.checks), 'Complete Worker and consistency snapshots are required');
  assert.equal(inventory.checks.gateway_public_route_present, true, 'Gateway must retain its public route');
  assert.equal(inventory.checks.tier1_kv_binding_present, true, 'Gateway Tier 1 KV is missing');
  assert.equal(inventory.checks.shared_token_stats_d1_consistent, true, 'Gateway and Operations must use the same D1');
  assert.equal(inventory.checks.declared_build_sha_consistent, true, 'All four Workers must declare one build SHA');
  assert.equal(inventory.checks.gateway_provider_credential_binding_count, 0, 'Gateway must not own Provider credentials');
  assert.equal(inventory.checks.private_worker_exposure_clear, true, 'Private Workers must have no public routes');
  assert.equal(inventory.checks.gateway_service_bindings?.AIG_INFERENCE_SERVICE, true, 'Inference Service Binding is invalid');
  assert.equal(inventory.checks.gateway_service_bindings?.AIG_GENERATION_SERVICE, true, 'Generation Service Binding is invalid');

  assert.ok(Array.isArray(inventory.unverified), 'The inventory must preserve its outstanding evidence list');
  for (const missing of REQUIRED_UNVERIFIED) {
    assert.ok(inventory.unverified.includes(missing), 'Inventory must not silently declare runtime evidence verified');
  }

  for (const workerName of WORKERS) {
    const worker = inventory.workers[workerName];
    assert.ok(record(worker) && worker.deployed === true, 'All four Workers must be deployed before protected verification');
    assert.equal(worker.active_deployment_present, true, 'A deployed Worker has no active deployment');
    assert.ok(worker.active_traffic_version_count > 0, 'A Worker has no active traffic version');
    assert.ok(Math.abs(worker.active_traffic_weight_total - 100) < 0.001, 'Active Worker traffic weights are invalid');
    assert.deepEqual(worker.crons, cronFor(phase, workerName), 'Unexpected live Cron owner or schedule');
    assert.deepEqual(worker.retired_binding_names, [], 'Retired Tier/OAuth bindings remain');
    assert.equal(worker.declared_build_sha, preflight.source_sha, 'Declared Worker build SHA differs from the immutable release plan');
  }
  assert.equal(inventory.workers['ai-gateway'].token_stats_db_binding_count, 1, 'Gateway must have one TOKEN_STATS_DB');
  assert.equal(inventory.workers['ai-gateway-operations'].token_stats_db_binding_count, 1, 'Operations must have one TOKEN_STATS_DB');

  assert.equal(preflight.ready_for_protected_review, true, 'Offline release preflight has not passed');
  assert.equal(preflight.production_deployment_authorized, false, 'Offline report must not authorize production');
  assert.equal(preflight.provider_secret_values_verified, false, 'Secret functionality cannot be asserted by an offline report');
  assert.equal(preflight.global_cron_propagation_verified, false, 'Global Cron propagation needs separate evidence');
  assert.ok(SOURCE_SHA.test(preflight.source_sha ?? ''), 'An immutable release SHA is required');
  assert.deepEqual(preflight.phase_order, PHASES, 'Expected the complete ordered prepare/detach/activate plan');
  assert.ok(Array.isArray(preflight.phases) && preflight.phases.length === PHASES.length, 'Three plan snapshots are required');
  for (const [index, stage] of PHASES.entries()) {
    const snapshot = preflight.phases[index];
    assert.equal(snapshot?.stage, stage, 'Release stage order changed');
    assert.equal(snapshot?.cron_owner, stage, 'Release plan Cron owner is invalid');
    assert.equal(snapshot?.requires_runtime_evidence_before_next_stage, true, 'Each stage requires runtime verification');
  }

  return {
    schema_version: 1,
    source_sha: preflight.source_sha,
    inspected_phase: phase,
    metadata_ready_for_protected_review: true,
    production_deployment_authorized: false,
    unverified: [...REQUIRED_UNVERIFIED],
  };
}

function main(argv) {
  if (argv.length !== 6 || argv[0] !== '--inventory' || argv[2] !== '--preflight' || argv[4] !== '--phase' || !argv[1] || !argv[3]) {
    throw new Error('usage: production-cutover-evidence.mjs --inventory PRIVATE_FILE --preflight PRIVATE_FILE --phase PHASE');
  }
  const inventory = JSON.parse(readFileSync(path.resolve(argv[1]), 'utf8'));
  const preflight = JSON.parse(readFileSync(path.resolve(argv[3]), 'utf8'));
  const report = assertReadOnlyCutoverEvidence(inventory, preflight, argv[5]);
  process.stdout.write(JSON.stringify(report) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch {
    // Inputs are protected metadata; never print their contents or paths.
    process.stderr.write('Protected cutover evidence rejected; review the two private reports. No resources changed.\n');
    process.exitCode = 2;
  }
}
