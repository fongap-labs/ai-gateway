#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Synthetic-only contract test: no Cloudflare credentials or network calls.
import assert from 'node:assert/strict';
import { BETA_WORKERS, planAiGatewayBetaResources } from './beta-resource-preflight.mjs';

const input = {
  DEPLOY_ENVIRONMENT: 'ai-gateway-beta',
  DEPLOY_SOURCE_SHA: 'a'.repeat(40),
  AIG_BETA_D1_ID: '223e4567-e89b-42d3-a456-426614174000',
  AIG_PRODUCTION_D1_ID: '123e4567-e89b-42d3-a456-426614174000',
  AIG_BETA_KV_ID: 'a'.repeat(32),
  AIG_PRODUCTION_KV_ID: 'b'.repeat(32),
};

const plan = planAiGatewayBetaResources(input);
assert.equal(plan.environment, 'ai-gateway-beta');
assert.equal(plan.source_branch, 'dev');
assert.equal(plan.source_sha, input.DEPLOY_SOURCE_SHA);
assert.deepEqual(Object.keys(plan.workers).sort(), [
  'gateway',
  'generation',
  'inference',
  'operations',
  'perception',
]);
assert.equal(new Set(Object.values(BETA_WORKERS)).size, 5);
assert.equal(plan.workers.gateway, 'ai-gateway-beta');
assert.equal(plan.workers.inference, 'ai-inference-center-beta');
assert.equal(plan.workers.perception, 'ai-perception-center-beta');
assert.equal(plan.workers.generation, 'ai-generation-center-beta');
assert.equal(plan.workers.operations, 'ai-gateway-operations-beta');
assert.deepEqual(plan.service_bindings, {
  AIG_INFERENCE_SERVICE: plan.workers.inference,
  AIG_PERCEPTION_SERVICE: plan.workers.perception,
  AIG_GENERATION_SERVICE: plan.workers.generation,
});
assert.equal(plan.d1.id, input.AIG_BETA_D1_ID);
assert.equal(plan.kv.id, input.AIG_BETA_KV_ID);
assert.deepEqual(plan.cron_schedules, []);
assert.deepEqual(plan.public_routes, []);
assert.equal(plan.workers_dev, false);
assert.equal(plan.remote_mutations_authorized, false);

for (const invalid of [
  { DEPLOY_ENVIRONMENT: 'production' },
  { DEPLOY_SOURCE_SHA: 'main' },
  { AIG_BETA_D1_ID: input.AIG_PRODUCTION_D1_ID },
  { AIG_BETA_D1_ID: '' },
  { AIG_PRODUCTION_D1_ID: '' },
  { AIG_BETA_KV_ID: input.AIG_PRODUCTION_KV_ID },
  { AIG_BETA_KV_ID: '' },
  { AIG_PRODUCTION_KV_ID: '' },
  { CLOUDFLARE_API_TOKEN: 'do-not-accept' },
  { AIG_INFERENCE_AUTH_KEY: 'do-not-accept' },
  { AIG_ACCESS_KEY_AIR: 'do-not-accept' },
  { AIG_TIER1_CREDENTIALS_01: 'do-not-accept' },
]) {
  assert.throws(
    () => planAiGatewayBetaResources({ ...input, ...invalid }),
    Error,
    'Invalid Beta resource identity or private credential was accepted',
  );
}

console.log('Five-Worker Beta resource identity, D1/KV separation and no-write preflight passed.');
