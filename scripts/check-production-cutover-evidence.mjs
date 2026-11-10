#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { assertReadOnlyCutoverEvidence } from './production-cutover-evidence.mjs';

const SHA = 'a'.repeat(40);
const CRON = '0 3 * * *';
const WORKERS = ['ai-gateway', 'ai-inference-center', 'ai-perception-center', 'ai-generation-center', 'ai-gateway-operations'];
const PHASES = ['prepare', 'detach', 'activate'];
const UNVERIFIED = [
  'provider-secret-values-and-credential-functionality',
  'node-json-oauth-markers-and-migration-conflicts',
  'five-worker-build-sha-equality',
  'runtime-health-and-request-metrics',
  'global-cron-propagation-and-independent-runtime-evidence',
  'rollback-drill',
];
function inventoryFor(stage) {
  const workers = Object.fromEntries(
    WORKERS.map((name) => [
      name,
      {
        deployed: true,
        active_deployment_present: true,
        active_traffic_version_count: 1,
        active_traffic_weight_total: 100,
        declared_build_sha: SHA,
        retired_binding_names: [],
        crons: name === 'ai-gateway' && stage === 'prepare' ? [CRON] : name === 'ai-gateway-operations' && stage === 'activate' ? [CRON] : [],
        token_stats_db_binding_count: name === 'ai-gateway' || name === 'ai-gateway-operations' ? 1 : 0,
      },
    ]),
  );
  return {
    report_type: 'cloudflare_read_only_inventory',
    production_cutover_approved: false,
    access_requirement: { secret_values_requested_or_reported: false },
    metadata_consistency: 'pass',
    blockers: [],
    cron_phase: stage,
    workers,
    checks: {
      gateway_public_route_present: true,
      tier1_kv_binding_present: true,
      shared_token_stats_d1_consistent: true,
      declared_build_sha_consistent: true,
      gateway_provider_credential_binding_count: 0,
      private_worker_exposure_clear: true,
      gateway_service_bindings: { AIG_INFERENCE_SERVICE: true, AIG_PERCEPTION_SERVICE: true, AIG_GENERATION_SERVICE: true },
    },
    unverified: [...UNVERIFIED],
  };
}
const preflight = {
  ready_for_protected_review: true,
  production_deployment_authorized: false,
  provider_secret_values_verified: false,
  global_cron_propagation_verified: false,
  source_sha: SHA,
  phase_order: PHASES,
  phases: PHASES.map((stage) => ({ stage, cron_owner: stage, requires_runtime_evidence_before_next_stage: true })),
};
function rejects(change, stage = 'prepare') {
  const inventory = inventoryFor(stage);
  const plan = structuredClone(preflight);
  change(inventory, plan);
  assert.throws(() => assertReadOnlyCutoverEvidence(inventory, plan, stage));
}

for (const stage of PHASES) {
  const report = assertReadOnlyCutoverEvidence(inventoryFor(stage), structuredClone(preflight), stage);
  assert.equal(report.metadata_ready_for_protected_review, true);
  assert.equal(report.production_deployment_authorized, false);
  assert.equal(report.source_sha, SHA);
  assert.deepEqual(report.unverified, UNVERIFIED);
}
rejects((i) => (i.metadata_consistency = 'blocked'));
rejects((i) => i.blockers.push('GATEWAY_PROVIDER_CREDENTIALS_PRESENT'));
rejects((i) => (i.cron_phase = 'activate'));
rejects((i) => (i.workers['ai-gateway'].deployed = false));
rejects((i) => (i.workers['ai-inference-center'].active_traffic_weight_total = 95));
rejects((i) => (i.workers['ai-inference-center'].crons = [CRON]));
rejects((i) => (i.workers['ai-perception-center'].crons = [CRON]));
rejects((i) => (i.workers['ai-gateway-operations'].crons = [CRON]));
rejects((i) => (i.workers['ai-gateway'].crons = []));
rejects((i) => (i.workers['ai-gateway'].retired_binding_names = ['AIG_TIER3_NODES_01']));
rejects((i) => (i.workers['ai-gateway-operations'].token_stats_db_binding_count = 0));
rejects((i) => (i.checks.shared_token_stats_d1_consistent = false));
rejects((i) => (i.checks.declared_build_sha_consistent = false));
rejects((i) => (i.workers['ai-inference-center'].declared_build_sha = 'b'.repeat(40)));
rejects((i) => (i.workers['ai-gateway'].declared_build_sha = null));
rejects((i) => (i.checks.private_worker_exposure_clear = false));
rejects((i) => (i.checks.gateway_service_bindings.AIG_INFERENCE_SERVICE = false));
rejects((i) => (i.checks.gateway_service_bindings.AIG_PERCEPTION_SERVICE = false));
rejects((i) => (i.checks.gateway_provider_credential_binding_count = 1));
rejects((i) => (i.access_requirement.secret_values_requested_or_reported = true));
rejects((i) => i.unverified.splice(0, 1));
rejects((i) => (i.production_cutover_approved = true));
rejects((i, p) => (p.production_deployment_authorized = true));
rejects((i, p) => (p.provider_secret_values_verified = true));
rejects((i, p) => (p.global_cron_propagation_verified = true));
rejects((i, p) => (p.source_sha = 'main'));
rejects((i, p) => (p.phases[0].cron_owner = 'activate'));
rejects((i, p) => (p.phases[0].requires_runtime_evidence_before_next_stage = false));
assert.throws(() => assertReadOnlyCutoverEvidence(inventoryFor('prepare'), preflight, 'unknown'));
console.log('Protected five-Worker evidence contract passed (read-only metadata, Cron phase, no implicit production authorization).');
