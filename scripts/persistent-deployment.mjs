#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Deployment-only path: runtime provider and application secrets stay in Cloudflare.
// This script reads only secret names from Wrangler; it never receives runtime secret values.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnosticsGroups } from '../src/config/access-keys.ts';
import { buildWranglerConfig, collectVarsFromEnv, normalizeNodeConfigJsonText, verifyRemote } from './github-deployment-config.mjs';

const NODE_VAR = /^AIG_TIER[123]_NODES_(0[1-9]|10)$/;
const NODE_SECRET = /^AIG_TIER[123]_CREDENTIALS_(0[1-9]|10)$/;
const GROUP_SECRET = /^AIG_ACCESS_KEY_(AIR|PRO|MAX|ULTRA|AGENT)$/;

function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return value;
}

function deploymentVars(env) {
  const vars = collectVarsFromEnv(env).vars;
  for (const [name, value] of Object.entries(vars)) {
    if (NODE_VAR.test(name)) vars[name] = normalizeNodeConfigJsonText(value);
  }
  return vars;
}

export function validateDeploymentInputs(env) {
  const errors = [];
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'AIG_PUBLIC_URL', 'AIG_DEPLOY_HEALTH_KEY']) {
    if (typeof env[name] !== 'string' || !env[name].trim()) errors.push(`${name} is required for deployment.`);
  }
  if (env.AIG_PUBLIC_URL && !/^https:\/\//.test(String(env.AIG_PUBLIC_URL).trim())) {
    errors.push('AIG_PUBLIC_URL must be an absolute https URL.');
  }

  const allowedDiagnostics = diagnosticsGroups(env.AIG_DIAGNOSTICS_GROUPS);
  if (allowedDiagnostics !== null && !allowedDiagnostics.has('AGENT')) {
    errors.push('AIG_DIAGNOSTICS_GROUPS must allow AGENT because AIG_DEPLOY_HEALTH_KEY maps to AIG_ACCESS_KEY_AGENT.');
  }

  const vars = deploymentVars(env);
  const nodeConfigNames = Object.keys(vars).filter((name) => NODE_VAR.test(name));
  if (nodeConfigNames.length === 0) errors.push('At least one AIG_TIER{1,2,3}_NODES_XX variable is required.');
  for (const name of nodeConfigNames) {
    let parsed;
    try {
      parsed = JSON.parse(vars[name]);
    } catch {
      errors.push(`${name} must contain valid JSON.`);
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) errors.push(`${name} must contain a non-empty node array.`);
  }
  if (Object.keys(vars).some((name) => /^AIG_TIER1_NODES_(0[1-9]|10)$/.test(name)) && !String(env.AIG_AFFINITY_KV_ID || '').trim()) {
    errors.push('AIG_AFFINITY_KV_ID is required when Tier 1 nodes are configured.');
  }
  if (env.AIG_ANALYTICS_DATASET && !/^[A-Za-z0-9_]{1,64}$/.test(String(env.AIG_ANALYTICS_DATASET).trim())) {
    errors.push('AIG_ANALYTICS_DATASET must be 1-64 letters, digits or underscores.');
  }

  let config;
  try {
    config = buildWranglerConfig(vars, env.AIG_USAGE_D1_ID, env.AIG_AFFINITY_KV_ID, env.AIG_ANALYTICS_DATASET);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Worker deployment configuration is invalid.');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { vars, config };
}

export function validateRemoteSecretInventory(secretList, wranglerConfig) {
  if (!Array.isArray(secretList)) throw new Error('Wrangler secret inventory must be a JSON array.');
  const names = new Set();
  for (const entry of secretList) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.type !== 'secret_text') {
      throw new Error('Wrangler secret inventory contains an invalid entry; refusing deployment.');
    }
    names.add(entry.name);
  }

  const missing = [];
  if (!names.has('AIG_ACCESS_KEY_AGENT')) missing.push('AIG_ACCESS_KEY_AGENT');
  if (![...names].some((name) => NODE_SECRET.test(name))) missing.push('AIG_TIER[123]_CREDENTIALS_XX (at least one shard)');

  const services = Array.isArray(wranglerConfig?.services) ? wranglerConfig.services : [];
  if (services.some((service) => service?.binding === 'AIG_INFERENCE_SERVICE') && !names.has('AIG_INFERENCE_AUTH_KEY')) {
    missing.push('AIG_INFERENCE_AUTH_KEY');
  }
  if (services.some((service) => service?.binding === 'AIG_GENERATION_SERVICE') && !names.has('AIG_GENERATION_AUTH_KEY')) {
    missing.push('AIG_GENERATION_AUTH_KEY');
  }

  const usesOAuth = Object.entries(wranglerConfig?.vars || {}).some(([name, raw]) => {
    if (!/^AIG_TIER2_NODES_(0[1-9]|10)$/.test(name)) return false;
    try {
      const nodes = JSON.parse(String(raw));
      return Array.isArray(nodes) && nodes.some((node) => node?.auth === 'oauth');
    } catch {
      return false;
    }
  });
  if (usesOAuth && !names.has('AIG_TOKEN_ENCRYPTION_KEY')) missing.push('AIG_TOKEN_ENCRYPTION_KEY');

  if (missing.length) {
    throw new Error(`Cloudflare Worker secret inventory is incomplete: ${missing.join(', ')}. Add the missing secrets through the ai-gateway-ops workflow; normal code deployment will not upload runtime secrets.`);
  }

  return {
    total: names.size,
    accessKeyGroups: [...names].filter((name) => GROUP_SECRET.test(name)).length,
    credentialShards: [...names].filter((name) => NODE_SECRET.test(name)).length,
    oauthEncryptionKey: names.has('AIG_TOKEN_ENCRYPTION_KEY'),
    inferenceAuthKey: names.has('AIG_INFERENCE_AUTH_KEY'),
    generationAuthKey: names.has('AIG_GENERATION_AUTH_KEY'),
  };
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'preflight') {
    const { vars } = validateDeploymentInputs(process.env);
    console.log(`Deployment preflight passed: ${Object.keys(vars).length} Worker variable(s); runtime secrets are not read from GitHub.`);
    return;
  }
  if (command === 'prepare') {
    const wrangler = argValue(argv, '--wrangler');
    const summary = argValue(argv, '--summary');
    if (!wrangler || !summary) throw new Error('usage: persistent-deployment.mjs prepare --wrangler FILE --summary FILE');
    const { vars, config } = validateDeploymentInputs(process.env);
    fs.writeFileSync(wrangler, JSON.stringify(config, null, 2), { mode: 0o600 });
    const models = (() => {
      try { return Object.keys(JSON.parse(vars.AIG_MODELS_CONFIG || '{}')).length; } catch { return 0; }
    })();
    fs.writeFileSync(
      summary,
      [
        'Deployment configuration prepared',
        '',
        `  Worker variables: ${Object.keys(config.vars || {}).length}`,
        `  Model aliases: ${models}`,
        `  D1: ${config.d1_databases ? 'configured' : 'disabled'}`,
        `  Tier 1 affinity KV: ${config.kv_namespaces ? 'configured' : 'disabled'}`,
        `  Analytics Engine: ${config.analytics_engine_datasets ? 'configured' : 'disabled'}`,
        '  Runtime secrets: preserved in Cloudflare; not uploaded by this deployment',
        '',
      ].join('\\n'),
    );
    console.log('Deployment configuration prepared; no runtime secret values were read or written.');
    return;
  }
  if (command === 'verify-secrets') {
    const file = argValue(argv, '--file');
    const configFile = argValue(argv, '--wrangler');
    if (!file || !configFile) throw new Error('usage: persistent-deployment.mjs verify-secrets --file FILE --wrangler FILE');
    const result = validateRemoteSecretInventory(readJson(file, 'Wrangler secret inventory'), readJson(configFile, 'Generated Wrangler config'));
    console.log(
      `Cloudflare runtime secret inventory passed: ${result.total} secret name(s), ${result.credentialShards} credential shard(s). Values were not read.`,
    );
    return;
  }
  if (command === 'health-check') {
    const key = String(process.env.AIG_DEPLOY_HEALTH_KEY || '');
    if (!key.trim()) throw new Error('AIG_DEPLOY_HEALTH_KEY is required for the post-deploy health check.');
    const allowedDiagnostics = diagnosticsGroups(process.env.AIG_DIAGNOSTICS_GROUPS);
    if (allowedDiagnostics !== null && !allowedDiagnostics.has('AGENT')) {
      throw new Error('AIG_DIAGNOSTICS_GROUPS must allow AGENT for the deployment health check.');
    }
    const expectedBuild = argValue(argv, '--expected-build') || undefined;
    await verifyRemote(process.env.AIG_PUBLIC_URL, key, expectedBuild, {
      allowDegraded: String(process.env.AIG_ALLOW_DEGRADED || '').toLowerCase() === 'true',
    });
    console.log('Remote health checks passed.');
    return;
  }
  throw new Error('usage: persistent-deployment.mjs <preflight|prepare|verify-secrets|health-check>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
