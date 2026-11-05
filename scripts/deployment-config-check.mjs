#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_GROUPS } from '../src/config/access-keys.ts';
import { canReadDiagnostics } from '../src/observability/diagnostic-endpoints.ts';
import { authorize, authorizeDeploymentHealth, isDeploymentHealthCountTokensProbe, isDeploymentHealthRoute } from '../src/request/auth.ts';
import { redistributeUnusedTierAttempts } from '../src/request/tier-loop.ts';
import { buildWranglerConfig, DEFAULT_OPTIMAL_VARS } from './github-deployment-config.mjs';
import { buildInferenceCenterDeployment } from './inference-center-deployment.mjs';
import { assertNodesArray, parseJsonFile } from './node-config-shards.mjs';
import { validateDeploymentInputs, validateRemoteSecretInventory } from './persistent-deployment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const config = JSON.parse(read('wrangler.jsonc'));

assert.equal(config.keep_vars, true);
assert.equal(config.main, 'src/index.ts');
assert.equal(config.secrets, undefined);
assert.equal(config.env, undefined);
assert.equal(config.vars, undefined);
assert.ok(Array.isArray(config.triggers?.crons) && config.triggers.crons.includes('0 3 * * *'));
assert.ok(fs.existsSync(path.join(root, 'package-lock.json')), 'package-lock.json is required for npm ci');

const tooling = [
  'scripts/node-config-shards.mjs',
  'scripts/plan-node-configuration.mjs',
  'scripts/cloudflare-wrangler.mjs',
  'scripts/github-deployment-config.mjs',
  'scripts/persistent-deployment.mjs',
  'scripts/deploy.sh',
];
for (const file of tooling) assert.ok(fs.existsSync(path.join(root, file)), `Missing deployment/tooling file: ${file}`);
assert.ok(fs.existsSync(path.join(root, 'src/providers/registry.ts')), 'Provider adapter registry must be single-sourced');

const accessGroupPattern = KEY_GROUPS.join('|');

const pkg = JSON.parse(read('package.json'));
for (const scriptName of ['deploy', 'tail', 'cf:login', 'cf:whoami']) {
  assert.match(pkg.scripts?.[scriptName] || '', /cloudflare-wrangler\.mjs/);
}
assert.match(pkg.scripts?.deploy || '', /cloudflare-wrangler\.mjs\s+deploy/);

const wranglerTool = read('scripts/cloudflare-wrangler.mjs');
assert.match(wranglerTool, /wrangler@4\.114\.0/, 'Wrangler pin has one tooling owner');
for (const file of ['package.json']) {
  assert.doesNotMatch(read(file), /wrangler@\d+\.\d+\.\d+/, `${file} must not duplicate the Wrangler pin`);
}
for (const token of ['migrations', 'apply', 'TOKEN_STATS_DB', '--remote', '--dry-run', 'TIER1_AFFINITY']) {
  assert.ok(wranglerTool.includes(token), `cloudflare-wrangler.mjs must include ${token}`);
}

for (const removed of [
  'scripts/deploy.ps1',
  'scripts/update.sh',
  'scripts/update.ps1',
  'scripts/setup-and-deploy.sh',
  'scripts/setup-and-deploy.ps1',
  'scripts/install.sh',
  'scripts/install.ps1',
  'scripts/reconfigure.sh',
  'scripts/reconfigure.ps1',
]) {
  assert.equal(fs.existsSync(path.join(root, removed)), false, `${removed} must not return as duplicate lifecycle tooling`);
}

const workflowDir = path.join(root, '.github', 'workflows');
const permanentWorkflows = ['ci.yml', 'notify-action-worker.yml'];
assert.deepEqual(
  fs
    .readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort(),
  permanentWorkflows,
  'only thin repository workflows may live in .github/workflows',
);

const deployManifest = JSON.parse(read('.github/deploy.json'));
assert.deepEqual(deployManifest, {
  schema_version: '1',
  adapter: 'source-script',
  automatic: true,
  ignore_docs_only: true,
  runner_profile: 'production-deploy',
  environment: 'production',
  entrypoint: 'scripts/deploy.sh',
});
const deploySecretScope = read('.github/deploy.secrets.allowed')
  .split(/\r?\n/)
  .map((line) => line.replace(/#.*/, '').trim())
  .filter(Boolean);
assert.deepEqual(deploySecretScope.sort(), ['AIG_DEPLOY_HEALTH_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
const deployRequired = read('.github/deploy.secrets.required')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
assert.deepEqual(deployRequired.sort(), deploySecretScope);
for (const runtimeSecret of [
  'AIG_TOKEN_ENCRYPTION_KEY',
  'AIG_INFERENCE_AUTH_KEY',
  'AIG_GENERATION_AUTH_KEY',
  'AIG_ACCESS_KEY_AIR',
  'AIG_ACCESS_KEY_PRO',
  'AIG_ACCESS_KEY_MAX',
  'AIG_ACCESS_KEY_ULTRA',
  'AIG_ACCESS_KEY_AGENT',
]) {
  assert.equal(deploySecretScope.includes(runtimeSecret), false, `${runtimeSecret} must stay in Cloudflare, not the production deploy environment`);
}
// The old inference-center product manifest was deleted. Keep testing the
// underlying private center configuration builder, but never re-introduce a
// second deploy product beside the root .github/ manifest.
assert.throws(() => buildInferenceCenterDeployment({}), /CLOUDFLARE_API_TOKEN/);
assert.throws(
  () =>
    buildInferenceCenterDeployment({
      CLOUDFLARE_API_TOKEN: 'test-token',
      CLOUDFLARE_ACCOUNT_ID: 'test-account',
      AIG_INFERENCE_AUTH_KEY: 'short',
    }),
  /at least 32/,
);
assert.match(read('scripts/cloudflare-wrangler.mjs'), /checkPrivateInferenceConfig/);
assert.equal(fs.existsSync(path.join(root, 'scripts/deploy-inference-center.sh')), false);

const centerBindingConfig = buildWranglerConfig({ AIG_INFERENCE_TARGET: 'ai-inference-center' });
assert.deepEqual(centerBindingConfig.services, [{ binding: 'AIG_INFERENCE_SERVICE', service: 'ai-inference-center' }]);
assert.equal(centerBindingConfig.vars.AIG_INFERENCE_TARGET, undefined);
assert.equal(buildWranglerConfig({}).services, undefined);
assert.throws(() => buildWranglerConfig({ AIG_INFERENCE_TARGET: 'other-center' }));
const generationBound = buildWranglerConfig({ AIG_GENERATION_TARGET: 'ai-generation-center' });
assert.deepEqual(generationBound.services, [{ binding: 'AIG_GENERATION_SERVICE', service: 'ai-generation-center' }]);
assert.equal(generationBound.vars.AIG_GENERATION_ACTIVE, 'true');
assert.equal(generationBound.vars.AIG_GENERATION_TARGET, undefined);
assert.equal(buildWranglerConfig({}).vars.AIG_GENERATION_ACTIVE, undefined);
assert.throws(() => buildWranglerConfig({ AIG_GENERATION_TARGET: 'untrusted-target' }));
const bothCenters = buildWranglerConfig({ AIG_INFERENCE_TARGET: 'ai-inference-center', AIG_GENERATION_TARGET: 'ai-generation-center' });
assert.equal(bothCenters.services.length, 2);

// Production deploy reads only deployment credentials; runtime secret values remain remote.
const deployInputs = {
  CLOUDFLARE_API_TOKEN: 'deploy-token',
  CLOUDFLARE_ACCOUNT_ID: 'account-id',
  AIG_PUBLIC_URL: 'https://api.example.test',
  AIG_DEPLOY_HEALTH_KEY: 'deployment-health-key-0123456789abcdef0123456789abcdef',
  AIG_TIER1_NODES_01: JSON.stringify([
    { id: 'node-1', provider: 'openai', base_url: 'https://provider.example.test/v1', models: { Chat: 'model-1' } },
  ]),
  AIG_AFFINITY_KV_ID: 'affinity-kv-id',
};
const deployPrepared = validateDeploymentInputs(deployInputs);
assert.equal(deployPrepared.config.name, 'ai-gateway');
assert.equal(Object.hasOwn(deployPrepared.config.vars, 'AIG_DEPLOY_HEALTH_KEY'), false);
assert.throws(() => validateDeploymentInputs({ ...deployInputs, AIG_DEPLOY_HEALTH_KEY: '' }), /AIG_DEPLOY_HEALTH_KEY/);
assert.throws(
  () => validateDeploymentInputs({ ...deployInputs, AIG_DEPLOY_HEALTH_KEY: 'too-short' }),
  /at least 32 characters using only URL-safe characters/,
);
const remoteSecretNames = [
  { name: 'AIG_ACCESS_KEY_AIR', type: 'secret_text' },
  { name: 'AIG_DEPLOY_HEALTH_KEY', type: 'secret_text' },
  { name: 'AIG_TIER1_CREDENTIALS_01', type: 'secret_text' },
];
assert.equal(validateRemoteSecretInventory(remoteSecretNames, deployPrepared.config).credentialShards, 1);
assert.throws(
  () =>
    validateRemoteSecretInventory(
      remoteSecretNames.filter((secret) => secret.name !== 'AIG_DEPLOY_HEALTH_KEY'),
      deployPrepared.config,
    ),
  /AIG_DEPLOY_HEALTH_KEY/,
);
assert.throws(
  () =>
    validateRemoteSecretInventory(
      remoteSecretNames.filter((secret) => secret.name !== 'AIG_ACCESS_KEY_AIR'),
      deployPrepared.config,
    ),
  /AIG_ACCESS_KEY_<GROUP>/,
);
assert.throws(
  () =>
    validateRemoteSecretInventory(
      remoteSecretNames.filter((secret) => secret.name !== 'AIG_TIER1_CREDENTIALS_01'),
      deployPrepared.config,
    ),
  /AIG_TIER\[123\]_CREDENTIALS_XX/,
);
assert.throws(
  () => validateRemoteSecretInventory([...remoteSecretNames, { name: 'AIG_ACCESS_KEY_MAX', type: 'plain_text' }], deployPrepared.config),
  /invalid entry/,
);
const generationPrepared = validateDeploymentInputs({ ...deployInputs, AIG_GENERATION_TARGET: 'ai-generation-center' });
assert.throws(() => validateRemoteSecretInventory(remoteSecretNames, generationPrepared.config), /AIG_GENERATION_AUTH_KEY/);
const oauthPrepared = validateDeploymentInputs({
  ...deployInputs,
  AIG_TIER2_NODES_01: JSON.stringify([{ id: 'oauth-1', provider: 'anthropic', auth: 'oauth', models: { Chat: 'claude' } }]),
});
assert.throws(() => validateRemoteSecretInventory(remoteSecretNames, oauthPrepared.config), /AIG_TOKEN_ENCRYPTION_KEY/);
assert.doesNotThrow(() =>
  validateRemoteSecretInventory([...remoteSecretNames, { name: 'AIG_TOKEN_ENCRYPTION_KEY', type: 'secret_text' }], oauthPrepared.config),
);

const deploymentHealthKey = 'deployment-health-key-0123456789abcdef0123456789abcdef';
const deploymentHealthRequest = new Request('https://gateway.example.test/health', {
  headers: { authorization: `Bearer ${deploymentHealthKey}` },
});
const deploymentHealthAuth = await authorizeDeploymentHealth(deploymentHealthRequest, {
  AIG_DEPLOY_HEALTH_KEY: deploymentHealthKey,
});
assert.ok(deploymentHealthAuth?.authorized && deploymentHealthAuth.mode === 'deploy');
assert.equal(deploymentHealthAuth.group, null);
assert.equal(deploymentHealthAuth.allowAll, false);
assert.equal(deploymentHealthAuth.allowlist.size, 0);
const reusedHealthKeyAuth = await authorize(deploymentHealthRequest, {
  AIG_ACCESS_KEY_AGENT: deploymentHealthKey,
  AIG_ACCESS_MODELS_AGENT: '*',
  AIG_DEPLOY_HEALTH_KEY: deploymentHealthKey,
});
assert.equal(reusedHealthKeyAuth.authorized, false);
assert.equal(canReadDiagnostics({ AIG_DIAGNOSTICS_GROUPS: 'MAX' }, deploymentHealthAuth), true);
assert.equal(await authorizeDeploymentHealth(deploymentHealthRequest, { AIG_DEPLOY_HEALTH_KEY: 'a-different-health-key' }), null);
assert.equal(isDeploymentHealthRoute('health'), true);
assert.equal(isDeploymentHealthRoute('models'), true);
assert.equal(isDeploymentHealthRoute('anthropic_count_tokens'), true);
assert.equal(isDeploymentHealthRoute('metrics'), false);
assert.equal(isDeploymentHealthRoute('openai_chat'), false);
assert.equal(isDeploymentHealthCountTokensProbe({ model: 'gateway-health-check', messages: [] }), true);
assert.equal(isDeploymentHealthCountTokensProbe({ model: 'gateway-health-check', messages: [{ role: 'user', content: 'x' }] }), false);
assert.equal(isDeploymentHealthCountTokensProbe({ model: 'other-model', messages: [] }), false);
assert.equal(isDeploymentHealthCountTokensProbe({ model: 'gateway-health-check', messages: [], system: 'not allowed' }), false);

// CLOUDFLARE_ACCOUNT_ID is not a stored Secret, but it must stay declared: the control-plane
// alias maps it to the CLOUDFLARE_ACCOUNT_ID_SECONDARY Variable, and resolve-secret-scope only
// applies an alias to a name the target declares in .github/deploy.secrets.allowed.
assert.ok(deploySecretScope.includes('CLOUDFLARE_ACCOUNT_ID'), 'CLOUDFLARE_ACCOUNT_ID must stay declared for the control-plane alias to inject it');
for (const forbidden of ['AW_CONTROL_TOKEN', 'AW_ADMIN_TOKEN', 'AW_DISPATCH_TOKEN']) {
  assert.equal(deploySecretScope.includes(forbidden), false, `deploy secret scope must not expose ${forbidden}`);
}

const taskSource = JSON.parse(read('.github/task-source.json'));
assert.equal(taskSource.schema_version, '1');
assert.equal(taskSource.push, false);
assert.deepEqual(taskSource.schedules, [
  {
    cron: '15 4 * * *',
    projects: ['model-discovery'],
  },
]);

const modelDiscoveryTask = JSON.parse(read('projects/model-discovery/task.json'));
assert.deepEqual(modelDiscoveryTask, {
  schema_version: '1',
  entrypoint: 'projects/model-discovery/run.sh',
});

const modelDiscoverySecretScope = read('projects/model-discovery/.secrets.allowed')
  .split(/\r?\n/)
  .map((line) => line.replace(/#.*/, '').trim())
  .filter(Boolean);
assert.ok(modelDiscoverySecretScope.length > 0);
assert.ok(modelDiscoverySecretScope.every((name) => /^AIG_TIER[123]_CREDENTIALS_\d{2}$/.test(name)));
for (const forbidden of ['AIG_ACCESS_KEY_AGENT', 'AW_CONTROL_TOKEN', 'AW_ADMIN_TOKEN', 'AW_DISPATCH_TOKEN']) {
  assert.equal(modelDiscoverySecretScope.includes(forbidden), false, `model discovery secret scope must not expose ${forbidden}`);
}
assert.equal(fs.existsSync(path.join(root, '.github', 'workflows', 'model-discovery.yml')), false);

const modelDiscoveryScript = read('projects/model-discovery/run.sh');
assert.match(modelDiscoveryScript, /AW_TASK_STATE_DIR/);
assert.match(modelDiscoveryScript, /provider-discovery\.mjs live/);
assert.doesNotMatch(modelDiscoveryScript, /AW_CONTROL_TOKEN|AW_ADMIN_TOKEN|AIG_ACCESS_KEY_AGENT/);

// Action Worker product discovery forbids mixing root deployment manifests with
// product manifests under projects/. Task-only projects remain supported.
const rootDeployManifest = JSON.parse(read('.github/deploy.json'));
assert.equal(rootDeployManifest.environment, 'production');
for (const item of fs.readdirSync(path.join(root, 'projects'), { withFileTypes: true })) {
  if (!item.isDirectory()) continue;
  for (const marker of ['deploy.json', 'follows.json', 'release.manifest.json']) {
    assert.equal(
      fs.existsSync(path.join(root, 'projects', item.name, marker)),
      false,
      `Mixed root/project manifest is forbidden: projects/${item.name}/${marker}`,
    );
  }
}

const deployScript = read('scripts/deploy.sh');
assert.match(deployScript, /persistent-deployment\.mjs verify-secrets/);
assert.match(deployScript, /secret list/);
assert.doesNotMatch(deployScript, /--secrets-file|gateway-secrets\.json/);
assert.match(deployScript, /cloudflare-wrangler\.mjs deploy/);
assert.match(deployScript, /cloudflare-wrangler\.mjs rollback/);
assert.match(deployScript, /persistent-deployment\.mjs health-check/);
assert.match(deployScript, /DEPLOY_SOURCE_SHA/);
assert.doesNotMatch(deployScript, /wrangler@\d+\.\d+\.\d+/);

for (const removedExample of ['config/tier2-nodes.example.json', 'config/node-secrets.example.json', 'config/gateway-secrets.example.json']) {
  assert.equal(fs.existsSync(path.join(root, removedExample)), false, `${removedExample} must stay absent`);
}
assert.ok(fs.existsSync(path.join(root, 'config/worker-vars.example.json')));

const tier1 = parseJsonFile(path.join(root, 'config/tier1-nodes.example.json'));
assertNodesArray(tier1, 'config/tier1-nodes.example.json', 1);
assert.ok(tier1.length >= 2, 'Tier 1 example should demonstrate multiple free-capacity nodes');
for (const n of tier1) {
  for (const required of ['id', 'provider', 'base_url', 'models']) {
    assert.ok(Object.hasOwn(n, required), `Tier 1 example node ${n.id || '?'} must explicitly declare ${required}`);
  }
  assert.equal(Object.hasOwn(n, 'protocol'), false, 'protocol belongs to Provider profile, not node JSON');
  assert.equal(Object.hasOwn(n, 'surfaces'), false, 'surfaces belong to Provider profile, not node JSON');
  assert.equal(Array.isArray(n.models), false, 'models must use current object mapping');
}
JSON.parse(read('config/models.example.json'));
const policiesExample = JSON.parse(read('config/policies.example.json'));
assert.equal(JSON.stringify(policiesExample).includes('budget_split'), false, 'policy example must not reintroduce alternate tier allocation');
const workerVars = JSON.parse(read('config/worker-vars.example.json'));
assert.equal(Object.hasOwn(workerVars, 'GATEWAY_CONFIG'), false);
assert.equal(Object.hasOwn(workerVars, 'GATEWAY_SECRETS_CONFIG'), false);
const accessExample = JSON.parse(read('config/access-keys.example.json'));
const groupKeyName = new RegExp(`^AIG_ACCESS_KEY_(${accessGroupPattern})$`);
const groupModelsName = new RegExp(`^AIG_ACCESS_MODELS_(${accessGroupPattern})$`);
assert.ok(Object.keys(accessExample).some((name) => groupKeyName.test(name)));
assert.ok(Object.keys(accessExample).some((name) => groupModelsName.test(name)));

const srcFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|ts)$/.test(entry.name)) srcFiles.push(full);
  }
}
walk(path.join(root, 'src'));
for (const file of srcFiles) {
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /\bbudgetSplit\b|\bbudget_split\b/, `${file} must not contain alternate tier-budget config`);
}

// Deployment defaults bound free-tier attempts while retaining explicit overrides.
assert.equal(DEFAULT_OPTIMAL_VARS.AIG_STREAM_MAX_ATTEMPTS, '3');
assert.equal(DEFAULT_OPTIMAL_VARS.AIG_NONSTREAM_MAX_ATTEMPTS, '3');
assert.equal(DEFAULT_OPTIMAL_VARS.AIG_REQUEST_HEDGE_MAX, '0');
assert.equal(buildWranglerConfig({ AIG_STREAM_MAX_ATTEMPTS: '4' }).vars.AIG_STREAM_MAX_ATTEMPTS, '4');
assert.equal(buildWranglerConfig({}).vars.AIG_STREAM_MAX_ATTEMPTS, '3');

// A free tier that runs out of selectable nodes must not strand attempts.
const policy = { maxAttempts: 5, tierAttempts: null };
assert.deepEqual(redistributeUnusedTierAttempts({ 1: 3, 2: 1, 3: 1 }, 1, 2, policy), { 1: 3, 2: 3, 3: 1 });
assert.deepEqual(redistributeUnusedTierAttempts({ 1: 3, 2: 1, 3: 1 }, 2, 2, policy), { 1: 3, 2: 1, 3: 3 });
assert.deepEqual(redistributeUnusedTierAttempts({ 1: 3, 2: 1, 3: 1 }, 1, 2, { maxAttempts: 5, tierAttempts: { tier2: 1 } }), { 1: 3, 2: 1, 3: 3 });
assert.deepEqual(redistributeUnusedTierAttempts({ 1: 3, 2: 1, 3: 1 }, 1, 2, { maxAttempts: 5, tierAttempts: { tier2: 1, tier3: 1 } }), {
  1: 3,
  2: 1,
  3: 1,
});
assert.deepEqual(redistributeUnusedTierAttempts({ 1: 3, 2: 1, 3: 1 }, 1, 0, policy), { 1: 3, 2: 1, 3: 1 });

console.log('Deployment configuration check passed.');
