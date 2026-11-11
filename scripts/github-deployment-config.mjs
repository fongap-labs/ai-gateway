#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_GROUPS } from '../src/config/access-keys.ts';
import { loadExecutionConfig, loadGatewayConfig } from '../src/config/nodes.ts';
import { RUNTIME_VAR_NAMES } from '../src/config/runtime-vars.ts';
import { normalizeNodeConfigJsonText } from './node-config-json-normalizer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAR_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const NODE_VAR = /^AIG_TIER[12]_NODES_(0[1-9]|10)$/;
const NODE_SECRET = /^AIG_TIER[12]_CREDENTIALS_(0[1-9]|10)$/;
const GROUP_KEY_PATTERN = `AIG_ACCESS_KEY_(?:${KEY_GROUPS.join('|')})`;
const GROUP_MODELS_PATTERN = `AIG_ACCESS_MODELS_(?:${KEY_GROUPS.join('|')})`;
const GROUP_KEY_RE = new RegExp(`^${GROUP_KEY_PATTERN}$`);
const GROUP_LABEL = KEY_GROUPS.join(', ');

const SECRET_NAME = new RegExp(
  `^(?:${GROUP_KEY_PATTERN}|AIG_TIER[12]_CREDENTIALS_(0[1-9]|10)|AIG_INFERENCE_AUTH_KEY|AIG_PERCEPTION_AUTH_KEY|AIG_GENERATION_AUTH_KEY|AIG_EDGE_CACHE_HMAC_KEY)$`,
);
const MAX_VALUE_BYTES = 4500;
const RUNTIME_VAR_PATTERN = new RegExp(
  `^(AIG_TIER[12]_NODES_(0[1-9]|10)|AIG_MODELS_CONFIG|AIG_POLICIES_CONFIG|${GROUP_MODELS_PATTERN}|${RUNTIME_VAR_NAMES.join('|')})$`,
);
const EXTRA_VAR_ALLOW = new Set(['AIG_BUILD_SHA', 'AIG_PUBLIC_URL', 'AIG_INFERENCE_TARGET', 'AIG_PERCEPTION_TARGET', 'AIG_GENERATION_TARGET']);
function assertTwoTierBindingNames(names) {
  const retired = [...names]
    .filter((name) => name.startsWith('AIG_OAUTH_') || name === 'AIG_IS_SUBSCRIPTION_ENABLED' || name === 'AIG_TOKEN_ENCRYPTION_KEY')
    .sort();
  if (retired.length > 0) {
    throw new Error(`Retired subscription bindings must be removed through controlled cutover: ${retired.join(', ')}`);
  }
  const legacy = [...names].filter((name) => name.startsWith('AIG_TIER3_')).sort();
  if (legacy.length > 0) {
    // Names only, never print any credential values.
    throw new Error(`Legacy Tier 3 bindings must be explicitly migrated before deploying: ${legacy.join(', ')}`);
  }
}

const CREDENTIAL_NAMES = new Set([
  'CLOUDFLARE_API_TOKEN',
  'AIG_INFERENCE_AUTH_KEY',
  'AIG_PERCEPTION_AUTH_KEY',
  'AIG_GENERATION_AUTH_KEY',
  'AIG_EDGE_CACHE_HMAC_KEY',
  ...KEY_GROUPS.map((group) => `AIG_ACCESS_KEY_${group}`),
]);

// A JSON.parse error quotes the text around the failure; for secrets that would
// copy part of a credential into the deploy log, so only the label is reported.
export function parseConfigObject(text, label = 'configuration', { isSecret = false } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch (error) {
    throw new Error(isSecret ? `${label} is not valid JSON` : `${label} is not valid JSON (${error.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function encodeValue(value, label) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) throw new Error(`${label} must not be null or empty`);
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`${label} has an unsupported value type`);
}

function assertSize(name, value) {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new Error(`${name} exceeds the ${MAX_VALUE_BYTES}-byte Worker variable limit; shard it first`);
  }
}

export { normalizeNodeConfigJsonText };

export function normalizeRuntimeConfig(raw) {
  assertTwoTierBindingNames([...Object.keys(raw.vars ?? {}), ...Object.keys(raw.secrets ?? {})]);
  const vars = {};
  const secrets = {};
  for (const [name, rawValue] of Object.entries(raw.vars)) {
    if (!VAR_NAME.test(name)) throw new Error(`vars.${name}: invalid Worker variable name`);
    if (CREDENTIAL_NAMES.has(name) || NODE_SECRET.test(name)) {
      throw new Error(`vars.${name}: credentials belong in secrets, never vars`);
    }
    const nodeVarMatch = /^AIG_TIER[12]_NODES_(\d{2})$/.exec(name);
    if (nodeVarMatch && Number(nodeVarMatch[1]) > 10) {
      throw new Error(`vars.${name}: shard index out of range (01..10); ignored`);
    }
    const encoded = encodeValue(rawValue, `vars.${name}`);
    const value = NODE_VAR.test(name) ? normalizeNodeConfigJsonText(encoded) : encoded;
    assertSize(name, value);
    vars[name] = value;
  }
  for (const [name, rawValue] of Object.entries(raw.secrets)) {
    if (!SECRET_NAME.test(name)) {
      throw new Error(`secrets.${name}: only declared access, node, encryption, and inference Secrets are supported`);
    }
    const value = encodeValue(rawValue, `secrets.${name}`);
    assertSize(name, value);
    secrets[name] = value;
  }
  if (vars.AIG_INFERENCE_TARGET && (typeof secrets.AIG_INFERENCE_AUTH_KEY !== 'string' || secrets.AIG_INFERENCE_AUTH_KEY.length < 32)) {
    throw new Error('AIG_INFERENCE_AUTH_KEY Secret is required for private inference service binding.');
  }
  if (vars.AIG_GENERATION_TARGET && (typeof secrets.AIG_GENERATION_AUTH_KEY !== 'string' || secrets.AIG_GENERATION_AUTH_KEY.length < 32)) {
    throw new Error('AIG_GENERATION_AUTH_KEY Secret is required for private generation service binding.');
  }
  if (vars.AIG_PERCEPTION_TARGET && (typeof secrets.AIG_PERCEPTION_AUTH_KEY !== 'string' || secrets.AIG_PERCEPTION_AUTH_KEY.length < 32)) {
    throw new Error('AIG_PERCEPTION_AUTH_KEY Secret is required for private perception service binding.');
  }
  if (!Object.keys(secrets).some((k) => GROUP_KEY_RE.test(k))) {
    throw new Error(`secrets must contain at least one AIG_ACCESS_KEY_<GROUP> (${GROUP_LABEL})`);
  }
  if (!Object.keys(vars).some((name) => NODE_VAR.test(name))) {
    throw new Error('vars must contain at least one AIG_TIER{1,2}_NODES_XX value');
  }
  if (!Object.keys(secrets).some((name) => NODE_SECRET.test(name))) {
    throw new Error('secrets must contain at least one AIG_TIER[12]_CREDENTIALS_XX value');
  }
  return { vars, secrets };
}

export function loadRuntimeConfig(varsText, secretsText, varsLabel = 'Worker variables', secretsLabel = 'Gateway secrets') {
  return normalizeRuntimeConfig({
    vars: parseConfigObject(varsText, varsLabel),
    secrets: parseConfigObject(secretsText, secretsLabel, { isSecret: true }),
  });
}

export function collectVarsFromEnv(env) {
  const vars = {};
  for (const [name, value] of Object.entries(env)) {
    if (value == null || String(value).trim() === '') continue;
    if (CREDENTIAL_NAMES.has(name) || NODE_SECRET.test(name)) continue;
    if (RUNTIME_VAR_PATTERN.test(name) || EXTRA_VAR_ALLOW.has(name)) vars[name] = String(value);
  }
  return { vars };
}

export function collectSecretsFromEnv(env) {
  const secrets = {};
  for (const [name, value] of Object.entries(env)) {
    if (value == null || String(value).trim() === '') continue;
    if (SECRET_NAME.test(name)) secrets[name] = String(value);
  }
  return { secrets };
}

function countNodesInShards(vars, tierNumber) {
  const pattern = new RegExp(`^AIG_TIER${tierNumber}_NODES_(0[1-9]|10)$`);
  let count = 0;
  for (const [name, value] of Object.entries(vars)) {
    if (!pattern.test(name)) continue;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) count += parsed.length;
    } catch {
      // Preflight reports malformed JSON through the node-count diagnostics.
    }
  }
  return count;
}

export function buildRuntimeFromEnv(env) {
  assertTwoTierBindingNames(Object.keys(env));
  const v = collectVarsFromEnv(env);
  const s = collectSecretsFromEnv(env);
  return { runtime: normalizeRuntimeConfig({ vars: v.vars, secrets: s.secrets }) };
}

const REQUIRED_VARS = ['CLOUDFLARE_ACCOUNT_ID', 'AIG_PUBLIC_URL'];
const REQUIRED_SECRETS = ['CLOUDFLARE_API_TOKEN'];

export function preflight(env) {
  const errors = [];
  const oldBindings = Object.keys(env)
    .filter((name) => name.startsWith('AIG_TIER3_'))
    .sort();
  if (oldBindings.length > 0) errors.push(`Legacy Tier 3 bindings require explicit two-tier cutover: ${oldBindings.join(', ')}`);
  const warnings = [];
  for (const name of REQUIRED_VARS) {
    if (!env[name] || String(env[name]).trim() === '') errors.push(`${name} is missing from GitHub Repository Variables.`);
  }
  for (const name of REQUIRED_SECRETS) {
    if (!env[name] || String(env[name]).trim() === '') errors.push(`${name} is missing from GitHub Repository Secrets.`);
  }
  const groupKeys = Object.keys(env).filter((k) => GROUP_KEY_RE.test(k) && env[k] && String(env[k]).trim() !== '');
  if (!groupKeys.length) errors.push(`At least one AIG_ACCESS_KEY_<GROUP> (${GROUP_LABEL}) is missing from GitHub Repository Secrets.`);

  const v = collectVarsFromEnv(env);
  const s = collectSecretsFromEnv(env);
  const tierShards = Object.keys(v.vars).filter((n) => NODE_VAR.test(n)).length;
  const tier1Shards = Object.keys(v.vars).filter((n) => /^AIG_TIER1_NODES_(0[1-9]|10)$/.test(n)).length;
  for (const [name, value] of Object.entries(v.vars)) {
    if (NODE_VAR.test(name) && normalizeNodeConfigJsonText(value) !== value) {
      warnings.push(`${name} contains full-width JSON punctuation; deployment will normalize it. Fix the GitHub Variable at source.`);
    }
  }
  const totalManaged = Object.keys(v.vars).length + Object.keys(s.secrets).length;
  if (totalManaged > 80) warnings.push(`Worker variable + secret count is ${totalManaged} (threshold 80). Consolidate shards or reduce node count.`);
  if (!tierShards) errors.push('No AIG_TIER{1,2}_NODES_XX GitHub Variable is configured.');
  if (tier1Shards && (!env.AIG_AFFINITY_KV_ID || String(env.AIG_AFFINITY_KV_ID).trim() === '')) {
    errors.push('AIG_AFFINITY_KV_ID is required when Tier 1 nodes are configured.');
  }
  if (!Object.keys(s.secrets).some((n) => NODE_SECRET.test(n))) {
    errors.push('No AIG_TIER[12]_CREDENTIALS_XX Secret is configured.');
  }
  if (tier1Shards && countNodesInShards(v.vars, 1) === 1) {
    warnings.push('Only one Tier 1 node is configured; there is no account-level failover if that key is rate-limited or unavailable.');
  }
  // Unset means the runtime default (0, see runtime-vars.ts): the cap is off.
  const rpm = Number(v.vars.AIG_ACCESS_KEY_RPM ?? 0);
  if (tier1Shards && (!Number.isFinite(rpm) || rpm <= 0)) {
    warnings.push('AIG_ACCESS_KEY_RPM is 0; gateway access-key rate limiting is disabled.');
  }
  if (tier1Shards && !v.vars.AIG_POLICIES_CONFIG) {
    warnings.push('AIG_POLICIES_CONFIG is not set; Tier 1 max_in_flight is unlimited by default.');
  }
  if (!v.vars.AIG_MODELS_CONFIG) warnings.push('AIG_MODELS_CONFIG is not set (optional; the registry applies conservative defaults).');
  if (!v.vars.AIG_POLICIES_CONFIG) warnings.push('AIG_POLICIES_CONFIG is not set (optional; default attempt budgets apply).');
  if (!env.AIG_USAGE_D1_ID || String(env.AIG_USAGE_D1_ID).trim() === '') warnings.push('D1 persistence disabled: AIG_USAGE_D1_ID is not configured.');
  const inferenceTarget = String(env.AIG_INFERENCE_TARGET || '').trim();
  if (inferenceTarget && inferenceTarget !== 'ai-inference-center') errors.push('AIG_INFERENCE_TARGET must be ai-inference-center.');
  if (inferenceTarget && (typeof env.AIG_INFERENCE_AUTH_KEY !== 'string' || String(env.AIG_INFERENCE_AUTH_KEY).length < 32)) {
    errors.push('AIG_INFERENCE_AUTH_KEY Secret is required when AIG_INFERENCE_TARGET is configured.');
  }
  const generationTarget = String(env.AIG_GENERATION_TARGET || '').trim();
  if (generationTarget && generationTarget !== 'ai-generation-center') errors.push('AIG_GENERATION_TARGET must be ai-generation-center.');
  if (generationTarget && (typeof env.AIG_GENERATION_AUTH_KEY !== 'string' || String(env.AIG_GENERATION_AUTH_KEY).length < 32)) {
    errors.push('AIG_GENERATION_AUTH_KEY Secret is required when AIG_GENERATION_TARGET is configured.');
  }
  const perceptionTarget = String(env.AIG_PERCEPTION_TARGET || '').trim();
  if (perceptionTarget && perceptionTarget !== 'ai-perception-center') errors.push('AIG_PERCEPTION_TARGET must be ai-perception-center.');
  if (perceptionTarget && (typeof env.AIG_PERCEPTION_AUTH_KEY !== 'string' || String(env.AIG_PERCEPTION_AUTH_KEY).length < 32)) {
    errors.push('AIG_PERCEPTION_AUTH_KEY Secret is required when AIG_PERCEPTION_TARGET is configured.');
  }
  const analyticsDataset = String(env.AIG_ANALYTICS_DATASET || '').trim();
  if (analyticsDataset && !ANALYTICS_DATASET_NAME.test(analyticsDataset)) {
    errors.push('AIG_ANALYTICS_DATASET must be 1-64 letters, digits or underscores.');
  }
  const managedEnv = { ...v.vars, ...s.secrets };
  const config = loadGatewayConfig(managedEnv);
  // Even though the public Gateway is metadata-only, deployment preflight
  // MUST still validate the independent private Provider execution snapshot.
  // Otherwise a cross-tier or ambiguous secret could silently pass the gate.
  const privateExecutionConfig = loadExecutionConfig(managedEnv);
  if (!privateExecutionConfig.ready || privateExecutionConfig.hasConfigErrors) {
    errors.push(`Private execution configuration is invalid: ${privateExecutionConfig.diagnostics.join('; ')}`);
  }
  // A rejected setting is a mistake to fix, not capacity to accept: the runtime
  // keeps serving around it, but it never ships, whatever AIG_ALLOW_DEGRADED says.
  if (config.hasConfigErrors) {
    errors.push(`Runtime configuration has errors: ${config.diagnostics.join('; ')}`);
  } else if (config.status === 'degraded' && String(env.AIG_ALLOW_DEGRADED || '').toLowerCase() !== 'true') {
    const details = config.diagnostics.length ? `: ${config.diagnostics.join('; ')}` : '';
    errors.push(
      `Runtime configuration is degraded (${config.nodesUsable}/${config.nodesTotal} usable nodes); fix the excluded nodes or set AIG_ALLOW_DEGRADED=true${details}`,
    );
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function buildDeploymentSummary({ config, runtime, d1Configured, affinityKvConfigured, analyticsDataset, removedSecretShards = 0 }) {
  const modelsCount = (() => {
    try {
      return Object.keys(JSON.parse(runtime.vars.AIG_MODELS_CONFIG || '{}')).length;
    } catch {
      return 0;
    }
  })();
  return [
    'Deployment completed',
    '',
    'Gateway',
    `  Status: ${config.status}`,
    `  Nodes: ${config.nodesUsable}/${config.nodesTotal} usable${config.nodesUsable < config.nodesTotal ? ' (DEGRADED: some configured nodes were excluded)' : ''}`,
    `  Models: ${modelsCount}`,
    '',
    'Configuration',
    `  Worker variables: ${Object.keys(runtime.vars).length}`,
    `  Node secret shards: ${Object.keys(runtime.secrets).filter((n) => NODE_SECRET.test(n)).length}`,
    `  Obsolete node-secret shards removed: ${removedSecretShards}`,
    `  Request admission: ${runtime.vars.AIG_REQUEST_ADMISSION ?? DEFAULT_OPTIMAL_VARS.AIG_REQUEST_ADMISSION}`,
    `  Streaming attempt ceiling: ${runtime.vars.AIG_STREAM_MAX_ATTEMPTS ?? DEFAULT_OPTIMAL_VARS.AIG_STREAM_MAX_ATTEMPTS}`,
    `  Non-streaming attempt ceiling: ${runtime.vars.AIG_NONSTREAM_MAX_ATTEMPTS ?? DEFAULT_OPTIMAL_VARS.AIG_NONSTREAM_MAX_ATTEMPTS}`,
    `  Maximum hedge dispatches: ${runtime.vars.AIG_REQUEST_HEDGE_MAX ?? DEFAULT_OPTIMAL_VARS.AIG_REQUEST_HEDGE_MAX}`,
    '',
    'D1',
    `  Status: ${String(d1Configured || '').trim() ? 'ready' : 'disabled (AIG_USAGE_D1_ID is not configured)'}`,
    '',
    'Tier 1 affinity KV',
    `  Status: ${String(affinityKvConfigured || '').trim() ? 'ready' : 'missing (AIG_AFFINITY_KV_ID is not configured)'}`,
    '',
    'Attempt analytics',
    `  Status: ${String(analyticsDataset || '').trim() ? `ready (dataset ${String(analyticsDataset).trim()})` : 'disabled (AIG_ANALYTICS_DATASET is not configured)'}`,
    '',
    'Health',
    `  /health                    ${config.status === 'degraded' ? 'DEGRADED (allowed by AIG_ALLOW_DEGRADED)' : 'OK'}`,
    '  /v1/models                 OK',
    '  /v1/messages/count_tokens  OK',
  ].join('\n');
}

export function withStaleNodeSecretsRemoved(secrets, existingSecrets) {
  const out = { ...secrets };
  // Never automatically remove old Tier 3 Secrets during a breaking cutover.
  // The operator must explicitly authorize any destructive Secret cleanup.
  for (const entry of Array.isArray(existingSecrets) ? existingSecrets : []) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name === 'string' && /^AIG_TIER[12]_CREDENTIALS_(0[1-9]|10)$/.test(name) && !(name in out)) out[name] = null;
  }
  return out;
}

export function validateGatewayRuntime(runtime, { allowDegraded = false } = {}) {
  const env = { ...runtime.vars, ...runtime.secrets };
  const config = loadGatewayConfig(env);
  // The Gateway no longer reads secret shards. Validate them at the same
  // strict private-center boundary before any deployment package is emitted.
  const privateExecutionConfig = loadExecutionConfig(env);
  if (!privateExecutionConfig.ready || privateExecutionConfig.hasConfigErrors) {
    const details = privateExecutionConfig.diagnostics.length ? `: ${privateExecutionConfig.diagnostics.join('; ')}` : '';
    throw new Error(
      `private execution runtime configuration is ${privateExecutionConfig.ready ? 'in error' : privateExecutionConfig.status}${details}`,
    );
  }
  if (!config.ready || config.hasConfigErrors) {
    const details = config.diagnostics.length ? `: ${config.diagnostics.join('; ')}` : '';
    throw new Error(`gateway runtime configuration is ${config.ready ? 'in error' : config.status}${details}`);
  }
  if (!allowDegraded && config.status === 'degraded') {
    const details = config.diagnostics.length ? `: ${config.diagnostics.join('; ')}` : '';
    throw new Error(
      `gateway runtime configuration is degraded (${config.nodesUsable}/${config.nodesTotal} usable nodes); fix the excluded nodes or set AIG_ALLOW_DEGRADED=true${details}`,
    );
  }
  return config;
}

// Workers Analytics Engine dataset names: letters, digits and underscores.
const ANALYTICS_DATASET_NAME = /^[A-Za-z0-9_]{1,64}$/;

export const DEFAULT_OPTIMAL_VARS = {
  AIG_STREAM_PASSTHROUGH: 'true',
  AIG_HOT_PATH_GUARDS: 'true',
  AIG_COST_GUARDS: 'true',
  AIG_TIER1_PROBE_V2: 'true',
  AIG_REQUEST_ADMISSION: 'true',
  AIG_ISOLATE_MAX_IN_FLIGHT: '8',
  // Keep request-admission ceilings aligned with the built-in Tier 1-first
  // chat/coding policies. The bounded request-wide cap remains 8 and explicit
  // operator limits still win; Tier 2 retains one baseline fallback attempt.
  AIG_STREAM_MAX_ATTEMPTS: '8',
  AIG_NONSTREAM_MAX_ATTEMPTS: '8',
  AIG_REQUEST_HEDGE_MAX: '0',
  AIG_UPSTREAM_HEADER_TIMEOUT_MS: '60000',
  AIG_FIRST_EVENT_TIMEOUT_MS: '60000',
  AIG_FAILOVER_BUDGET_MS: '90000',
};

export function buildWranglerConfig(vars, d1DatabaseId = '', affinityKvId = '', analyticsDataset = '') {
  const inferenceTarget = String(vars.AIG_INFERENCE_TARGET ?? '').trim();
  if (inferenceTarget && inferenceTarget !== 'ai-inference-center') throw new Error('Invalid AIG_INFERENCE_TARGET.');
  const generationTarget = String(vars.AIG_GENERATION_TARGET ?? '').trim();
  if (generationTarget && generationTarget !== 'ai-generation-center') throw new Error('Invalid AIG_GENERATION_TARGET.');
  const perceptionTarget = String(vars.AIG_PERCEPTION_TARGET ?? '').trim();
  if (perceptionTarget && perceptionTarget !== 'ai-perception-center') throw new Error('Invalid AIG_PERCEPTION_TARGET.');
  // Deployment-only selector: never expose this string as a Worker variable.
  const runtimeVars = { ...vars };
  delete runtimeVars.AIG_INFERENCE_TARGET;
  delete runtimeVars.AIG_GENERATION_TARGET;
  delete runtimeVars.AIG_PERCEPTION_TARGET;
  delete runtimeVars.AIG_INFERENCE_ACTIVE;
  delete runtimeVars.AIG_GENERATION_ACTIVE;
  delete runtimeVars.AIG_PERCEPTION_ACTIVE;
  if (inferenceTarget) runtimeVars.AIG_INFERENCE_ACTIVE = 'true';
  if (generationTarget) runtimeVars.AIG_GENERATION_ACTIVE = 'true';
  if (perceptionTarget) runtimeVars.AIG_PERCEPTION_ACTIVE = 'true';
  const out = {
    name: 'ai-gateway',
    main: path.resolve(root, 'src/index.ts'),
    compatibility_date: '2026-08-06',
    workers_dev: false,
    keep_vars: false,
    observability: { enabled: true },
    triggers: { crons: ['0 3 * * *'] },
    vars: { ...DEFAULT_OPTIMAL_VARS, ...runtimeVars },
    ...(inferenceTarget || perceptionTarget || generationTarget
      ? {
          services: [
            ...(inferenceTarget ? [{ binding: 'AIG_INFERENCE_SERVICE', service: inferenceTarget }] : []),
            ...(perceptionTarget ? [{ binding: 'AIG_PERCEPTION_SERVICE', service: perceptionTarget }] : []),
            ...(generationTarget ? [{ binding: 'AIG_GENERATION_SERVICE', service: generationTarget }] : []),
          ],
        }
      : {}),
  };
  if (String(d1DatabaseId || '').trim()) {
    out.d1_databases = [
      {
        binding: 'TOKEN_STATS_DB',
        database_name: 'ai-gateway-stats',
        database_id: String(d1DatabaseId).trim(),
        migrations_dir: path.resolve(root, 'migrations'),
      },
    ];
  }
  if (String(affinityKvId || '').trim()) {
    out.kv_namespaces = [{ binding: 'TIER1_AFFINITY', id: String(affinityKvId).trim() }];
  }
  if (String(analyticsDataset || '').trim()) {
    out.analytics_engine_datasets = [{ binding: 'GATEWAY_EVENTS', dataset: String(analyticsDataset).trim() }];
  }
  return out;
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Cannot read ${file}`);
  }
}
function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
function hasFlag(argv, flag) {
  return argv.includes(flag);
}
function readSecretList(file) {
  const parsed = JSON.parse(readFile(file));
  if (!Array.isArray(parsed)) throw new Error(`${file} must be a JSON array from "wrangler secret list"`);
  return parsed;
}
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Remote deployment identity is the commit SHA returned by public /health/ready.
// The endpoint exposes only build, readiness and degradation status.
export async function verifyRemote(baseUrl, expectedBuild, { graceMs = 30_000, intervalMs = 5_000, allowDegraded = false } = {}) {
  const origin = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(origin)) throw new Error('AIG_PUBLIC_URL must be an absolute https URL');
  if (expectedBuild !== undefined && !/^[a-f0-9]{40}$/i.test(expectedBuild)) {
    throw new Error('Expected build must be a full commit SHA');
  }

  const deadline = Date.now() + (expectedBuild === undefined ? 0 : graceMs);
  let readinessBody = null;
  let readinessStatus = 0;
  let lastError = null;
  do {
    try {
      const readiness = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(15000) });
      readinessStatus = readiness.status;
      readinessBody = await readiness.json().catch(() => null);
      if (!readiness.ok || readinessBody?.ready !== true) {
        lastError = new Error(`remote /health/ready is not ready (HTTP ${readiness.status}, status ${readinessBody?.status || 'unknown'})`);
      } else if (expectedBuild !== undefined && readinessBody?.build !== expectedBuild) {
        lastError = new Error(
          `Remote /health/ready.build does not match the validated deployment SHA (got ${readinessBody?.build ?? 'unknown'}, expected ${expectedBuild})`,
        );
      } else if (!allowDegraded && readinessBody?.degraded === true) {
        lastError = new Error('Remote /health/ready reports degraded capacity; fix the excluded nodes or set AIG_ALLOW_DEGRADED=true');
      } else {
        lastError = null;
        break;
      }
    } catch (e) {
      lastError = e;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleepMs(Math.min(intervalMs, remaining));
  } while (Date.now() < deadline);
  if (lastError) throw lastError;
  if (readinessBody?.ready !== true) {
    throw new Error(`remote /health/ready is not ready (HTTP ${readinessStatus}, status ${readinessBody?.status || 'unknown'})`);
  }
  return readinessBody.build;
}

function resolveRuntime(argv) {
  if (hasFlag(argv, '--from-env')) return buildRuntimeFromEnv(process.env).runtime;
  const varsInput = argValue(argv, '--vars');
  const secretsInput = argValue(argv, '--secrets-input');
  if (!varsInput || !secretsInput) {
    throw new Error('usage: prepare --from-env | --vars FILE --secrets-input FILE --wrangler FILE --secrets FILE [--existing-secrets FILE]');
  }
  return loadRuntimeConfig(readFile(varsInput), readFile(secretsInput), varsInput, secretsInput);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'preflight') {
    const result = preflight(process.env);
    for (const w of result.warnings) console.warn(`WARNING: ${w}`);
    if (result.errors.length) {
      for (const e of result.errors) console.error(`ERROR: ${e}`);
      process.exitCode = 1;
      return;
    }
    const v = collectVarsFromEnv(process.env);
    const s = collectSecretsFromEnv(process.env);
    const tierShards = Object.keys(v.vars).filter((n) => NODE_VAR.test(n)).length;
    const secretShards = Object.keys(s.secrets).filter((n) => NODE_SECRET.test(n)).length;
    console.log(
      `Preflight passed: ${tierShards} node-config shard(s), ${secretShards} credential shard(s), ${Object.keys(v.vars).length + Object.keys(s.secrets).length} total binding(s), Gateway Access Group Key present.`,
    );
    return;
  }
  if (command === 'prepare') {
    const wrangler = argValue(argv, '--wrangler');
    const secretsOut = argValue(argv, '--secrets');
    if (!wrangler || !secretsOut)
      throw new Error('usage: prepare --from-env | --vars FILE --secrets-input FILE --wrangler FILE --secrets FILE [--existing-secrets FILE]');
    const runtime = resolveRuntime(argv);
    const allowDegraded = String(process.env.AIG_ALLOW_DEGRADED || '').toLowerCase() === 'true';
    const config = validateGatewayRuntime(runtime, { allowDegraded });
    const existingSecretsFile = argValue(argv, '--existing-secrets');
    const bulkSecrets = existingSecretsFile ? withStaleNodeSecretsRemoved(runtime.secrets, readSecretList(existingSecretsFile)) : runtime.secrets;
    fs.writeFileSync(
      wrangler,
      JSON.stringify(
        buildWranglerConfig(runtime.vars, process.env.AIG_USAGE_D1_ID, process.env.AIG_AFFINITY_KV_ID, process.env.AIG_ANALYTICS_DATASET),
        null,
        2,
      ),
    );
    fs.writeFileSync(secretsOut, JSON.stringify(bulkSecrets), { mode: 0o600 });
    const removed = Object.values(bulkSecrets).filter((value) => value === null).length;
    const summaryOut = argValue(argv, '--summary');
    if (summaryOut) {
      fs.writeFileSync(
        summaryOut,
        `${buildDeploymentSummary({
          config,
          runtime,
          d1Configured: process.env.AIG_USAGE_D1_ID,
          affinityKvConfigured: process.env.AIG_AFFINITY_KV_ID,
          analyticsDataset: process.env.AIG_ANALYTICS_DATASET,
          removedSecretShards: removed,
        })}\n`,
      );
    }
    console.log(
      `Runtime configuration package is valid: ${config.nodesUsable}/${config.nodesTotal} usable node(s), ${Object.keys(runtime.vars).length} Worker text variable(s), ${Object.keys(runtime.secrets).length} Worker Secret(s), ${removed} obsolete node-secret shard(s) removed.`,
    );
    return;
  }
  if (command === 'health-check') {
    const allowDegraded = String(process.env.AIG_ALLOW_DEGRADED || '').toLowerCase() === 'true';
    await verifyRemote(process.env.AIG_PUBLIC_URL, argValue(argv, '--expected-build') || undefined, {
      allowDegraded,
    });
    console.log('Remote readiness check passed.');
    return;
  }
  throw new Error('usage: github-deployment-config.mjs <preflight|prepare|health-check> ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
