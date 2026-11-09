// SPDX-License-Identifier: MIT
// Fail-closed deployment allowlist. Pure metadata validation, no credentials.
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
const D1 = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
const NODE_VAR = /^AIG_TIER[12]_NODES_(0[1-9]|10)$/;
const RETIRED = /^(?:AIG_TIER3_|AIG_OAUTH_|AIG_IS_SUBSCRIPTION_ENABLED$|AIG_TOKEN_ENCRYPTION_KEY$)/;
const SECRET_VAR = /(?:^|_)SECRET(?:_|$)|(?:^|_)AUTH_KEY$|_CREDENTIALS_|^AIG_ACCESS_KEY_|^AIG_DEPLOY_HEALTH_KEY$|^AIG_EDGE_CACHE_HMAC_KEY$|^CLOUDFLARE_/;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function noFields(config, fields) {
  return fields.every((field) => !Object.hasOwn(config, field));
}

function privateBase(config) {
  return (
    record(config) &&
    config.workers_dev === false &&
    noFields(config, ['route', 'routes', 'custom_domains', 'services', 'secrets', 'env', 'inherit', 'assets'])
  );
}

function safeCenterVars(config) {
  const vars = config.vars;
  return (
    record(vars) &&
    typeof vars.AIG_BUILD_SHA === 'string' &&
    SHA.test(vars.AIG_BUILD_SHA) &&
    typeof vars.AIG_MODELS_CONFIG === 'string' &&
    typeof vars.AIG_POLICIES_CONFIG === 'string' &&
    Object.keys(vars).some((name) => NODE_VAR.test(name)) &&
    Object.keys(vars).every((name) => !RETIRED.test(name) && !SECRET_VAR.test(name))
  );
}

function isPrivateInference(config, root) {
  return (
    privateBase(config) &&
    config.name === 'ai-inference-center' &&
    config.main === path.join(root, 'src/inference/inference-center-entry.ts') &&
    config.keep_vars === false &&
    noFields(config, ['triggers', 'kv_namespaces']) &&
    safeCenterVars(config)
  );
}

function isPrivateGeneration(config, root) {
  return (
    privateBase(config) &&
    config.name === 'ai-generation-center' &&
    config.main === path.join(root, 'src/generation/generation-center-entry.ts') &&
    config.keep_vars === false &&
    noFields(config, ['triggers', 'kv_namespaces', 'd1_databases']) &&
    safeCenterVars(config)
  );
}

function isPrivateOperations(config) {
  const bindings = config?.d1_databases;
  return (
    privateBase(config) &&
    config.name === 'ai-gateway-operations' &&
    config.main === 'operations/standalone.ts' &&
    noFields(config, ['vars', 'kv_namespaces']) &&
    Array.isArray(config.triggers?.crons) &&
    config.triggers.crons.length === 0 &&
    Array.isArray(bindings) &&
    bindings.length === 1 &&
    record(bindings[0]) &&
    bindings[0].binding === 'TOKEN_STATS_DB' &&
    typeof bindings[0].database_name === 'string' &&
    bindings[0].database_name.length > 0 &&
    typeof bindings[0].database_id === 'string' &&
    D1.test(bindings[0].database_id)
  );
}

function hasUsageD1(config) {
  const databases = config.d1_databases;
  return (
    Array.isArray(databases) &&
    databases.length === 1 &&
    record(databases[0]) &&
    databases[0].binding === 'TOKEN_STATS_DB' &&
    typeof databases[0].database_name === 'string' &&
    databases[0].database_name.length > 0 &&
    typeof databases[0].database_id === 'string' &&
    D1.test(databases[0].database_id)
  );
}

function isGateway(config, root) {
  if (!record(config) || config.name !== 'ai-gateway' || config.workers_dev !== false || config.keep_vars !== false) {
    return false;
  }
  if (!noFields(config, ['secrets', 'env', 'inherit', 'assets'])) return false;
  const composed = config.main === 'src/index.ts' || config.main === path.join(root, 'src/index.ts');
  const standalone = config.main === 'apps/gateway/index.ts' || config.main === path.join(root, 'apps/gateway/index.ts');
  const cron = config.triggers?.crons;
  if ((!composed && !standalone) || JSON.stringify(cron) !== JSON.stringify(composed ? ['0 3 * * *'] : [])) {
    return false;
  }
  if (!hasUsageD1(config)) return false;
  const kv = config.kv_namespaces;
  if (
    !Array.isArray(kv) ||
    kv.length !== 1 ||
    kv[0]?.binding !== 'TIER1_AFFINITY' ||
    typeof kv[0]?.id !== 'string' ||
    kv[0].id.length === 0
  ) {
    return false;
  }
  const vars = config.vars;
  if (
    !record(vars) ||
    typeof vars.AIG_BUILD_SHA !== 'string' ||
    !SHA.test(vars.AIG_BUILD_SHA) ||
    vars.AIG_INFERENCE_ACTIVE !== 'true' ||
    vars.AIG_GENERATION_ACTIVE !== 'true' ||
    Object.keys(vars).some((name) => RETIRED.test(name) || SECRET_VAR.test(name))
  ) {
    return false;
  }
  return (
    JSON.stringify(config.services) ===
    JSON.stringify([
      { binding: 'AIG_INFERENCE_SERVICE', service: 'ai-inference-center' },
      { binding: 'AIG_GENERATION_SERVICE', service: 'ai-generation-center' },
    ])
  );
}

/** Returns a recognized Worker or null; callers MUST fail closed on null. */
export function classifyDeployTarget(config, root) {
  if (isGateway(config, root)) return 'gateway';
  if (isPrivateInference(config, root)) return 'inference';
  if (isPrivateGeneration(config, root)) return 'generation';
  if (isPrivateOperations(config)) return 'operations';
  return null;
}
