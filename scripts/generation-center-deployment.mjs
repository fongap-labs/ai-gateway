// SPDX-License-Identifier: MIT
// Protected, offline config builder for the private image Generation Center.
// This module does not call Cloudflare or deploy/upload any Secret.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isImageGenerationProvider } from '../packages/contracts/image-capabilities.ts';
import { loadExecutionConfig } from '../src/config/nodes.ts';
import { collectSecretsFromEnv, collectVarsFromEnv, normalizeNodeConfigJsonText } from './github-deployment-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeVar = /^AIG_TIER[12]_NODES_(0[1-9]|10)$/;
const nodeSecret = /^AIG_TIER[12]_CREDENTIALS_(0[1-9]|10)$/;
const centerVars = new Set(['AIG_MODELS_CONFIG', 'AIG_POLICIES_CONFIG', 'AIG_PROTOCOL_FALLBACKS']);

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required private generation deployment setting: ${name}.`);
  return value;
}

function privateBase() {
  const text = fs.readFileSync(path.join(root, 'wrangler.generation-center.jsonc'), 'utf8');
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  if (
    config.name !== 'ai-generation-center' ||
    config.main !== 'src/generation/generation-center-entry.ts' ||
    config.workers_dev !== false ||
    ['routes', 'route', 'custom_domains', 'triggers', 'services', 'd1_databases', 'kv_namespaces'].some((name) =>
      Object.hasOwn(config, name),
    )
  ) {
    throw new Error('Generation deployment requires a private, unexposed Worker with no scheduled job.');
  }
  return config;
}

export function buildGenerationCenterDeployment(env) {
  const legacy = Object.keys(env).filter((name) =>
    name.startsWith('AIG_TIER3_') ||
    name.startsWith('AIG_OAUTH_') ||
    ['AIG_IS_SUBSCRIPTION_ENABLED', 'AIG_TOKEN_ENCRYPTION_KEY'].includes(name),
  );
  if (legacy.length > 0) throw new Error(`Legacy Tier 3 or member subscription bindings require cleanup: ${legacy.sort().join(', ')}`);
  required(env, 'CLOUDFLARE_API_TOKEN');
  required(env, 'CLOUDFLARE_ACCOUNT_ID');
  const auth = required(env, 'AIG_GENERATION_AUTH_KEY');
  if (auth.length < 32 || /^(.)\1+$/.test(auth)) throw new Error('AIG_GENERATION_AUTH_KEY requires at least 32 nontrivial characters.');
  const sourceSha = required(env, 'DEPLOY_SOURCE_SHA');
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('DEPLOY_SOURCE_SHA must be a full hexadecimal commit SHA.');

  const vars = {};
  for (const [name, value] of Object.entries(collectVarsFromEnv(env).vars)) {
    if (nodeVar.test(name)) vars[name] = normalizeNodeConfigJsonText(value);
    else if (centerVars.has(name)) vars[name] = value;
  }
  if (!Object.keys(vars).some((name) => nodeVar.test(name))) throw new Error('Missing private generation node shards.');
  if (!vars.AIG_MODELS_CONFIG || !vars.AIG_POLICIES_CONFIG) {
    throw new Error('Generation model registry and policies must be configured.');
  }
  const secrets = { AIG_GENERATION_AUTH_KEY: auth };
  for (const [name, value] of Object.entries(collectSecretsFromEnv(env).secrets)) {
    if (nodeSecret.test(name)) secrets[name] = value;
  }
  if (!Object.keys(secrets).some((name) => nodeSecret.test(name))) {
    throw new Error('Missing private generation upstream credential shards.');
  }
  for (const [name, value] of Object.entries(vars)) {
    if (!nodeVar.test(name)) continue;
    let nodes;
    try {
      nodes = JSON.parse(value);
    } catch {
      throw new Error(`Invalid node JSON in ${name}.`);
    }
    if (!Array.isArray(nodes) || nodes.some((node) =>
      !node || typeof node !== 'object' || Array.isArray(node) ||
      typeof node.provider !== 'string' || !isImageGenerationProvider(node.provider) || Object.hasOwn(node, 'auth'),
    )) {
      throw new Error(`${name}: only static image-generation nodes are permitted in the private Generation Center.`);
    }
  }
  const validation = loadExecutionConfig({ ...vars, ...secrets });
  if (!validation.ready || validation.hasConfigErrors || validation.nodesUsable === 0 ||
      validation.nodes.some((node) => !node.surfaces.includes('images_generations'))) {
    throw new Error('Generation node/model execution configuration is not ready.');
  }
  const config = {
    ...privateBase(),
    main: path.join(root, 'src/generation/generation-center-entry.ts'),
    keep_vars: false,
    vars: { ...vars, AIG_BUILD_SHA: sourceSha },
  };
  return { config, secrets, nodes: validation.nodesUsable };
}

// Explicit prepare is file-only; never add deploy, d1, or secret-upload commands here.
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
      throw new Error('Private generation deployment files must remain inside RUNNER_TEMP.');
    }
    const pack = buildGenerationCenterDeployment(process.env);
    fs.writeFileSync(configPath, JSON.stringify(pack.config, null, 2), { mode: 0o600 });
    fs.writeFileSync(secretsPath, JSON.stringify(pack.secrets), { mode: 0o600 });
    console.log(`Private generation deployment validated: ${pack.nodes} image node(s), no public route.`);
  } catch (error) {
    console.error(`Private generation deployment refused: ${error.message}`);
    process.exitCode = 1;
  }
}
