#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Protected private Worker bootstrap and inventory gate. Only non-sensitive
// Variables and Cloudflare Secret NAMES are consumed; no Secret values are read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isImageGenerationProvider } from '../packages/contracts/image-capabilities.ts';
import { getProviderProfile } from '../packages/contracts/provider-profiles.ts';
import { isBuiltinPolicyName } from '../src/config/policies.ts';
import { classifyDeployTarget } from './wrangler-deploy-guards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shaPattern = /^[a-f0-9]{40}$/;
const shardName = /^AIG_TIER([12])_NODES_(0[1-9]|10)$/;
const credentialName = /^AIG_TIER([12])_CREDENTIALS_(0[1-9]|10)$/;
const FORBIDDEN =
  /^(?:AIG_TIER3_|AIG_OAUTH_|AIG_TOKEN_ENCRYPTION_KEY$|AIG_IS_SUBSCRIPTION_ENABLED$|AIG_TIER[12]_CREDENTIALS_|AIG_ACCESS_KEY_|AIG_DEPLOY_HEALTH_KEY$|AIG_(?:INFERENCE|PERCEPTION|GENERATION)_AUTH_KEY$|AIG_EDGE_CACHE_HMAC_KEY$)/;
const centerTypes = Object.freeze({
  'ai-inference-center': {
    entry: 'src/inference/inference-center-entry.ts',
    base: 'wrangler.inference-center.jsonc',
    auth: 'AIG_INFERENCE_AUTH_KEY',
    kind: 'inference',
  },
  'ai-generation-center': {
    entry: 'src/generation/generation-center-entry.ts',
    base: 'wrangler.generation-center.jsonc',
    auth: 'AIG_GENERATION_AUTH_KEY',
    kind: 'generation',
  },
  'ai-perception-center': {
    entry: 'src/perception/perception-center-entry.ts',
    base: 'wrangler.perception-center.jsonc',
    auth: 'AIG_PERCEPTION_AUTH_KEY',
    kind: 'perception',
  },
});

function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function centerType(worker) {
  if (!Object.hasOwn(centerTypes, worker)) throw new Error('Unknown private Worker target.');
  return centerTypes[worker];
}
function checkedJson(raw, name) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
  if (!record(value)) throw new Error(`${name} must be a JSON object.`);
  return value;
}
function plainInputs(env) {
  const raw = env.AIG_OPS_VARIABLES_JSON;
  const vars = raw ? checkedJson(raw, 'Protected Variable snapshot') : env;
  for (const name of Object.keys(vars)) {
    if (/^(?:AIG_TIER3_|AIG_OAUTH_|AIG_TOKEN_ENCRYPTION_KEY$|AIG_IS_SUBSCRIPTION_ENABLED$)/.test(name) || (raw && FORBIDDEN.test(name))) {
      throw new Error(`Forbidden Secret or retired Variable in private release input: ${name}.`);
    }
  }
  // Direct deploy environments legitimately carry AIG_DEPLOY_HEALTH_KEY. Never
  // serialize it into the center config; only the public variable allowlist
  // below is copied into Cloudflare.
  return vars;
}

/** Build only a private Worker: no routes, public URLs, services or Secret values. */
export function buildPrivateCenterConfig(worker, input) {
  const target = centerType(worker);
  const env = plainInputs(input);
  const sourceSha = input.DEPLOY_SOURCE_SHA;
  if (typeof sourceSha !== 'string' || !shaPattern.test(sourceSha)) {
    throw new Error('Private Worker requires an immutable 40-digit DEPLOY_SOURCE_SHA.');
  }
  // Policy overrides are optional in the shared runtime. Built-in policies
  // default, fast, long-reasoning, chat and coding work without a Variable.
  // A custom model policy is NEVER silently mapped to a built-in default.
  if (typeof env.AIG_MODELS_CONFIG !== 'string' || !env.AIG_MODELS_CONFIG.trim()) {
    throw new Error('AIG_MODELS_CONFIG is required for private center release.');
  }
  const modelCatalog = checkedJson(env.AIG_MODELS_CONFIG, 'AIG_MODELS_CONFIG');
  const hasPolicyOverride = typeof env.AIG_POLICIES_CONFIG === 'string' && env.AIG_POLICIES_CONFIG.trim().length > 0;
  const policyOverrides = hasPolicyOverride ? checkedJson(env.AIG_POLICIES_CONFIG, 'AIG_POLICIES_CONFIG') : {};
  const problems = [];
  const referencedPolicies = new Set(
    Object.values(modelCatalog)
      .filter((entry) => record(entry) && typeof entry.policy === 'string' && entry.policy.trim())
      .map((entry) => entry.policy.trim()),
  );
  const unknownPolicies = [...referencedPolicies].filter((name) => !isBuiltinPolicyName(name) && !Object.hasOwn(policyOverrides, name)).sort();
  if (unknownPolicies.length > 0) {
    problems.push(`AIG_POLICIES_CONFIG is missing definitions for referenced custom policies: ${unknownPolicies.join(', ')}.`);
  }
  const vars = {
    AIG_BUILD_SHA: sourceSha,
    AIG_MODELS_CONFIG: env.AIG_MODELS_CONFIG,
    ...(hasPolicyOverride ? { AIG_POLICIES_CONFIG: env.AIG_POLICIES_CONFIG } : {}),
  };
  if (env.AIG_PROTOCOL_FALLBACKS) vars.AIG_PROTOCOL_FALLBACKS = env.AIG_PROTOCOL_FALLBACKS;

  let total = 0;
  const tiers = new Set();
  for (const [name, raw] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    const match = shardName.exec(name);
    if (!match) continue;
    if (typeof raw !== 'string') throw new Error(`${name} must be a JSON string.`);
    let all;
    try {
      all = JSON.parse(raw);
    } catch {
      throw new Error(`${name} must be valid JSON.`);
    }
    if (!Array.isArray(all)) throw new Error(`${name} must be a node array.`);
    for (const item of all) {
      if (
        !record(item) ||
        typeof item.provider !== 'string' ||
        Object.hasOwn(item, 'auth') ||
        Object.keys(item).some((k) => /^(?:token|secret|password|api_key|credential)$/i.test(k))
      ) {
        throw new Error(`${name} contains an invalid or embedded-credential node.`);
      }
    }
    const selected = all.flatMap((n) => {
      if (target.kind === 'generation') return isImageGenerationProvider(n.provider) ? [n] : [];
      if (target.kind === 'inference') return !isImageGenerationProvider(n.provider) ? [n] : [];
      if (!getProviderProfile(n.provider).imageInput) return [];
      const mappings = record(n.models) ? n.models : {};
      const visionNames = new Set(
        Object.entries(modelCatalog)
          .filter(([, entry]) => record(entry) && record(entry.capabilities) && entry.capabilities.vision === true)
          .map(([name]) => name.toLowerCase()),
      );
      const selectedMappings = Object.fromEntries(Object.entries(mappings).filter(([logical]) => visionNames.has(logical.toLowerCase())));
      // A wildcard node serves the catalog, so retain it only when at least one
      // explicitly vision-enabled logical model exists.
      if (Object.keys(mappings).length === 0) return visionNames.size ? [n] : [];
      if (!Object.keys(selectedMappings).length) return [];
      return [{ ...n, models: selectedMappings }];
    });
    if (!selected.length) continue;
    vars[name] = JSON.stringify(selected);
    tiers.add(match[1]);
    total += selected.length;
  }
  if (target.kind === 'perception') {
    vars.AIG_MODELS_CONFIG = JSON.stringify(
      Object.fromEntries(
        Object.entries(modelCatalog).filter(([, entry]) => record(entry) && record(entry.capabilities) && entry.capabilities.vision === true),
      ),
    );
  }
  if (!total) problems.push(`${worker} has no eligible node; do not publish an empty private center.`);
  if (problems.length) throw new Error(problems.join(' '));

  const baseText = fs.readFileSync(path.join(root, target.base), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const base = JSON.parse(baseText);
  const config = {
    ...base,
    name: worker,
    main: path.join(root, target.entry),
    workers_dev: false,
    keep_vars: false,
    vars,
  };
  const classification = classifyDeployTarget(config, root);
  if (classification !== target.kind) {
    throw new Error('Private Worker configuration is not on the approved Wrangler deploy allowlist.');
  }
  return { config, nodeCount: total, tiers: [...tiers].sort(), authName: target.auth };
}

/** Read-only preflight for the ENTIRE mandatory three-center topology.
 * Collects every missing model/policy/capability before mutating any Worker. */
export function preflightPrivateCenters(input) {
  const issues = [];
  for (const worker of Object.keys(centerTypes)) {
    try {
      buildPrivateCenterConfig(worker, input);
    } catch (error) {
      issues.push(`${worker}: ${error instanceof Error ? error.message : 'invalid configuration'}`);
    }
  }
  if (issues.length) throw new Error(`Private center readiness check failed: ${issues.join(' | ')}`);
  return { workers: Object.keys(centerTypes).length };
}

/** Verify names only. This is not proof of credential correctness or request health. */
export function verifyPrivateCenterSecretNames(worker, rawInventory, tiers) {
  const target = centerType(worker);
  if (!Array.isArray(rawInventory) || rawInventory.some((s) => !record(s) || typeof s.name !== 'string' || s.type !== 'secret_text')) {
    throw new Error('Private center Secret inventory is invalid.');
  }
  const names = new Set(rawInventory.map((s) => s.name));
  if (names.size !== rawInventory.length) throw new Error('Duplicate private center Secret names.');
  const invalid = [...names].filter((n) => n !== target.auth && !credentialName.test(n));
  if (invalid.length) throw new Error(`${worker} contains Secrets outside its ownership allowlist.`);
  if (!names.has(target.auth)) throw new Error(`${worker} is missing its internal auth Secret.`);
  if (!Array.isArray(tiers) || tiers.some((t) => t !== '1' && t !== '2')) {
    throw new Error('Private center node tier manifest is invalid.');
  }
  for (const tier of tiers) {
    if (![...names].some((name) => credentialName.test(name) && credentialName.exec(name)[1] === tier)) {
      throw new Error(`${worker} lacks Tier ${tier} provider credential shards.`);
    }
  }
  return { worker, secretNames: names.size, tierCount: tiers.length };
}
function argument(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? '' : process.argv[i + 1] || '';
}
function localPath(file) {
  const temp = process.env.RUNNER_TEMP;
  if (!temp || !file || path.dirname(path.resolve(file)) !== path.resolve(temp)) {
    throw new Error('Private center artifacts must be direct children of RUNNER_TEMP.');
  }
  return path.resolve(file);
}
function main() {
  const [command] = process.argv.slice(2);
  const worker = argument('--worker');
  if (command === 'preflight') {
    const result = preflightPrivateCenters(process.env);
    console.log(`Private center preflight passed: ${result.workers} Worker configs; no remote state mutated.`);
    return;
  }
  if (command === 'prepare') {
    const output = localPath(argument('--output'));
    const manifest = localPath(argument('--manifest'));
    const { config, nodeCount, tiers } = buildPrivateCenterConfig(worker, process.env);
    fs.writeFileSync(output, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(manifest, JSON.stringify({ worker, tiers }), { mode: 0o600, flag: 'wx' });
    console.log(`Private ${worker} configuration prepared: ${nodeCount} eligible node(s); no Secrets transferred.`);
    return;
  }
  if (command === 'verify-inventory') {
    const inventory = JSON.parse(fs.readFileSync(localPath(argument('--inventory')), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(localPath(argument('--manifest')), 'utf8'));
    assert.equal(worker, manifest.worker, 'Private center inventory target mismatch.');
    const result = verifyPrivateCenterSecretNames(worker, inventory, manifest.tiers);
    console.log(`Private ${result.worker} inventory passed: ${result.secretNames} Secret names; values and runtime readiness not verified.`);
    return;
  }
  throw new Error(
    'Usage: private-center-config.mjs preflight|prepare|verify-inventory [--worker WORKER --output FILE --manifest FILE | --worker WORKER --inventory FILE --manifest FILE].',
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // Do not echo operational metadata or values from supplied configuration.
    console.error(`Private center release blocked: ${error instanceof Error ? error.message : 'invalid input'}`);
    process.exitCode = 2;
  }
}
