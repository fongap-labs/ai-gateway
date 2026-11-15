#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Offline-only Beta resource preflight. Does not read provider Secrets, contact
// Cloudflare, create resources, change production topology or deploy anything.
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KV_ID = /^[0-9a-f]{32}$/i;

export const BETA_WORKERS = Object.freeze({
  gateway: 'ai-gateway-beta',
  inference: 'ai-inference-center-beta',
  perception: 'ai-perception-center-beta',
  generation: 'ai-generation-center-beta',
  operations: 'ai-gateway-operations-beta',
});

const PUBLIC_VARIABLE_SECRET =
  /^(?:CLOUDFLARE_API_TOKEN|AIG_(?:ACCESS_KEY_|INFERENCE_AUTH_KEY|PERCEPTION_AUTH_KEY|GENERATION_AUTH_KEY|TOKEN_ENCRYPTION_KEY|TIER[12]_CREDENTIALS_|EDGE_CACHE_HMAC_KEY|.*_PRIVATE_KEY|.*_HEALTH_KEY))/;

/**
 * Construct a write-disabled Beta plan from explicit, public resource IDs.
 * Production IDs are required for a distinct-resource comparison; callers
 * cannot omit them and obtain a false green verdict.
 */
export function planAiGatewayBetaResources(input) {
  if (input.DEPLOY_ENVIRONMENT !== 'ai-gateway-beta') {
    throw new Error('AI Gateway Beta requires the exact ai-gateway-beta Environment.');
  }
  if (!SHA.test(input.DEPLOY_SOURCE_SHA ?? '')) {
    throw new Error('AI Gateway Beta requires an immutable source SHA.');
  }
  for (const name of Object.keys(input)) {
    if (PUBLIC_VARIABLE_SECRET.test(name) || /(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|KEYRING|CREDENTIALS)(?:$|_)/.test(name)) {
      throw new Error('AI Gateway Beta resource preflight must not receive Secrets.');
    }
  }
  const betaD1 = input.AIG_BETA_D1_ID ?? '';
  const productionD1 = input.AIG_PRODUCTION_D1_ID ?? '';
  const betaKv = input.AIG_BETA_KV_ID ?? '';
  const productionKv = input.AIG_PRODUCTION_KV_ID ?? '';
  if (!D1_ID.test(betaD1) || !D1_ID.test(productionD1) || betaD1.toLowerCase() === productionD1.toLowerCase()) {
    throw new Error('Beta requires a dedicated D1 ID distinct from production.');
  }
  if (!KV_ID.test(betaKv) || !KV_ID.test(productionKv) || betaKv.toLowerCase() === productionKv.toLowerCase()) {
    throw new Error('Beta requires a dedicated KV namespace distinct from production.');
  }

  const services = Object.freeze({
    AIG_INFERENCE_SERVICE: BETA_WORKERS.inference,
    AIG_PERCEPTION_SERVICE: BETA_WORKERS.perception,
    AIG_GENERATION_SERVICE: BETA_WORKERS.generation,
  });
  for (const [name, worker] of Object.entries(BETA_WORKERS)) {
    if (!worker.endsWith('-beta') || !worker.startsWith('ai-') || worker === name) {
      throw new Error('Beta Worker names must be exclusive to the test environment.');
    }
  }
  return Object.freeze({
    environment: 'ai-gateway-beta',
    source_branch: 'dev',
    source_sha: input.DEPLOY_SOURCE_SHA,
    workers: BETA_WORKERS,
    service_bindings: services,
    d1: Object.freeze({ binding: 'TOKEN_STATS_DB', id: betaD1 }),
    kv: Object.freeze({ binding: 'TIER1_AFFINITY', id: betaKv }),
    cron_schedules: Object.freeze([]),
    public_routes: Object.freeze([]),
    workers_dev: false,
    remote_mutations_authorized: false,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    planAiGatewayBetaResources(process.env);
    console.log('AI Gateway Beta resource isolation passed offline checks; deployment remains disabled.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid AI Gateway Beta resource plan.');
    process.exitCode = 77;
  }
}
