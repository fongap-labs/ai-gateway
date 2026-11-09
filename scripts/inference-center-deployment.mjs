// SPDX-License-Identifier: MIT
// Only the isolated, protected center deployment consumes this package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExecutionConfig } from '../src/config/nodes.ts';
import { collectSecretsFromEnv, collectVarsFromEnv, normalizeNodeConfigJsonText } from './github-deployment-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeVar = /^AIG_TIER[12]_NODES_(0[1-9]|10)$/;
const nodeSecret = /^AIG_TIER[12]_CREDENTIALS_(0[1-9]|10)$/;
const centerVars = new Set(['AIG_MODELS_CONFIG', 'AIG_POLICIES_CONFIG', 'AIG_PROTOCOL_FALLBACKS']);

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required private inference deployment setting: ${name}.`);
  }
  return value;
}

function privateBase() {
  const text = fs.readFileSync(path.join(root, 'wrangler.inference-center.jsonc'), 'utf8');
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  if (
    config.name !== 'ai-inference-center' ||
    config.main !== 'src/inference/inference-center-entry.ts' ||
    config.workers_dev !== false ||
    ['routes', 'route', 'custom_domains', 'triggers', 'services'].some((key) => Object.hasOwn(config, key))
  ) {
    throw new Error('Inference deployment requires a private, unexposed Worker.');
  }
  return config;
}

export function buildInferenceCenterDeployment(env) {
  required(env, 'CLOUDFLARE_API_TOKEN');
  required(env, 'CLOUDFLARE_ACCOUNT_ID');
  const key = required(env, 'AIG_INFERENCE_AUTH_KEY');
  if (key.length < 32 || /^(.)\1+$/.test(key)) {
    throw new Error('AIG_INFERENCE_AUTH_KEY requires at least 32 nontrivial characters.');
  }
  const vars = {};
  for (const [name, value] of Object.entries(collectVarsFromEnv(env).vars)) {
    if (nodeVar.test(name)) vars[name] = normalizeNodeConfigJsonText(value);
    else if (centerVars.has(name)) vars[name] = value;
  }
  if (!Object.keys(vars).some((name) => nodeVar.test(name))) {
    throw new Error('Missing inference node configuration shards.');
  }
  if (!vars.AIG_MODELS_CONFIG || !vars.AIG_POLICIES_CONFIG) {
    throw new Error('Inference model registry and policies must be configured.');
  }
  const secrets = { AIG_INFERENCE_AUTH_KEY: key };
  for (const [name, value] of Object.entries(collectSecretsFromEnv(env).secrets)) {
    if (nodeSecret.test(name)) secrets[name] = value;
  }
  if (!Object.keys(secrets).some((name) => nodeSecret.test(name))) {
    throw new Error('Missing inference upstream credential shards.');
  }
  for (const [name, value] of Object.entries(vars)) {
    if (!nodeVar.test(name)) continue;
    let nodes;
    try { nodes = JSON.parse(value); } catch { throw new Error(`Invalid JSON in ${name}.`); }
    if (!Array.isArray(nodes)) throw new Error(`Invalid nodes in ${name}.`);
    if (nodes.some((node) => node && typeof node === 'object' && Object.hasOwn(node, 'auth'))) {
      throw new Error(`Legacy subscriber auth nodes must be removed from ${name} before deploying.`);
    }
  }
  const databaseId = String(env.AIG_USAGE_D1_ID || '').trim();
  const validation = loadExecutionConfig({ ...vars, ...secrets });
  if (!validation.ready || validation.hasConfigErrors) {
    throw new Error('Inference node/model execution configuration is not ready.');
  }
  const config = {
    ...privateBase(),
    main: path.join(root, 'src/inference/inference-center-entry.ts'),
    keep_vars: false,
    vars: { ...vars, AIG_BUILD_SHA: required(env, 'DEPLOY_SOURCE_SHA') },
    ...(databaseId
      ? {
          d1_databases: [
            {
              binding: 'TOKEN_STATS_DB',
              database_name: 'ai-gateway-stats',
              database_id: databaseId,
              migrations_dir: path.join(root, 'migrations'),
            },
          ],
        }
      : {}),
  };
  return { config, secrets, nodes: validation.nodesUsable };
}

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'prepare') throw new Error('Expected prepare command.');
    const configPath = arg('--config');
    const secretsPath = arg('--secrets');
    const temp = process.env.RUNNER_TEMP;
    if (!configPath || !secretsPath || !temp) throw new Error('Protected runner output paths are required.');
    const directory = path.resolve(temp);
    if ([configPath, secretsPath].some((name) => path.dirname(path.resolve(name)) !== directory)) {
      throw new Error('Private inference deployment files must remain inside RUNNER_TEMP.');
    }
    const pack = buildInferenceCenterDeployment(process.env);
    fs.writeFileSync(configPath, JSON.stringify(pack.config, null, 2), { mode: 0o600 });
    fs.writeFileSync(secretsPath, JSON.stringify(pack.secrets), { mode: 0o600 });
    console.log(`Private inference deployment validated: ${pack.nodes} node(s), no public route.`);
  } catch (error) {
    console.error(`Private inference deployment refused: ${error.message}`);
    process.exitCode = 1;
  }
}
