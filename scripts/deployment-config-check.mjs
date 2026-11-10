#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_GROUPS } from '../src/config/access-keys.ts';
import { canReadDiagnostics } from '../src/observability/diagnostic-endpoints.ts';
import { authorize, authorizeDeploymentHealth, isDeploymentHealthCountTokensProbe, isDeploymentHealthRoute } from '../src/request/auth.ts';
import { redistributeUnusedTierAttempts } from '../src/request/tier-loop.ts';
import {
  confirmPublishedIdentity,
  confirmRestoredIdentity,
  establishRecoveryBaseline,
  fetchActiveDeployment,
  guardedRollbackTarget,
  parseActiveDeployment,
  recordPublishedDeployment,
} from './deployment-recovery.mjs';
import { buildGenerationCenterDeployment } from './generation-center-deployment.mjs';
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
  'scripts/deployment-recovery.mjs',
  'scripts/deploy.sh',
  'scripts/cloudflare-live-inventory.mjs',
  'scripts/check-cloudflare-live-inventory.mjs',
];
for (const file of tooling) assert.ok(fs.existsSync(path.join(root, file)), `Missing deployment/tooling file: ${file}`);
assert.ok(fs.existsSync(path.join(root, 'src/providers/registry.ts')), 'Provider adapter registry must be single-sourced');

const accessGroupPattern = KEY_GROUPS.join('|');

const pkg = JSON.parse(read('package.json'));
assert.match(pkg.scripts['check:cloudflare-inventory'] || '', /check-cloudflare-live-inventory\.mjs/);
for (const gate of ['validate:merge', 'validate:deploy']) {
  assert.ok((pkg.scripts[gate] || '').includes('npm run check:cloudflare-inventory'), `${gate} must include the read-only inventory contract`);
}
const operationsBuild = JSON.parse(read('wrangler.operations-build.jsonc'));
assert.equal(operationsBuild.name, 'ai-operations-build-check');
assert.equal(operationsBuild.main, 'operations/standalone.ts');
assert.equal(operationsBuild.workers_dev, false);
assert.equal(operationsBuild.compatibility_date, config.compatibility_date);
for (const key of ['triggers', 'routes', 'route', 'custom_domains', 'services', 'vars', 'secrets', 'kv_namespaces', 'd1_databases', 'inherit']) {
  assert.equal(Object.hasOwn(operationsBuild, key), false, `Operations build-only config must not declare ${key}`);
}
assert.ok(
  Object.keys(operationsBuild).every((key) => ['name', 'main', 'workers_dev', 'compatibility_date', 'compatibility_flags'].includes(key)),
  'Operations build-only config cannot gain deployment properties',
);
assert.match(pkg.scripts['check:operations'] || '', /cloudflare-wrangler\.mjs deploy --dry-run --config wrangler\.operations-build\.jsonc/);
assert.ok(
  (pkg.scripts['validate:merge'] || '').includes('npm run check:operations') &&
    (pkg.scripts['validate:deploy'] || '').includes('npm run check:operations'),
  'Independent Operations build must be validated on every change',
);
// Build-only application configs must never become deployable production
// manifests. Each build uses its actual apps/*/index.ts entrypoint.
for (const [app, name] of [
  ['gateway', 'ai-gateway-app-build-check'],
  ['inference', 'ai-inference-app-build-check'],
  ['generation', 'ai-generation-app-build-check'],
]) {
  const buildConfig = JSON.parse(read(`wrangler.${app}-build.jsonc`));
  assert.equal(buildConfig.name, name);
  assert.equal(buildConfig.main, `apps/${app}/index.ts`);
  assert.equal(buildConfig.workers_dev, false);
  assert.equal(buildConfig.compatibility_date, config.compatibility_date);
  for (const key of ['triggers', 'routes', 'route', 'custom_domains', 'services', 'vars', 'secrets', 'kv_namespaces', 'd1_databases', 'inherit']) {
    assert.equal(Object.hasOwn(buildConfig, key), false, `Build-only ${app} cannot declare ${key}`);
  }
  assert.ok(
    Object.keys(buildConfig).every((key) => ['name', 'main', 'workers_dev', 'compatibility_date', 'compatibility_flags'].includes(key)),
    `Build-only ${app} config cannot gain deployment properties`,
  );
  assert.ok(
    (pkg.scripts['check:apps'] || '').includes(`deploy --dry-run --config wrangler.${app}-build.jsonc`),
    `Missing independent dry-run for apps/${app}/index.ts`,
  );
}
assert.ok(
  (pkg.scripts['validate:merge'] || '').includes('npm run check:apps') && (pkg.scripts['validate:deploy'] || '').includes('npm run check:apps'),
  'All independent app bundles must be validated on every change',
);
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
  automatic: false,
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
assert.match(read('scripts/cloudflare-wrangler.mjs'), /classifyDeployTarget/);
assert.match(read('scripts/wrangler-deploy-guards.mjs'), /isPrivateInference/);
assert.match(read('scripts/wrangler-deploy-guards.mjs'), /isPrivateGeneration/);
assert.match(read('scripts/wrangler-deploy-guards.mjs'), /isPrivateOperations/);
assert.equal(fs.existsSync(path.join(root, 'scripts/deploy-inference-center.sh')), false);

assert.throws(() => buildGenerationCenterDeployment({}), /CLOUDFLARE_API_TOKEN/);
assert.throws(
  () =>
    buildGenerationCenterDeployment({
      CLOUDFLARE_API_TOKEN: 'test-deploy-key',
      CLOUDFLARE_ACCOUNT_ID: 'test-account',
      AIG_GENERATION_AUTH_KEY: 'short',
    }),
  /at least 32/,
);
const generationImage = {
  CLOUDFLARE_API_TOKEN: 'test-deploy-key',
  CLOUDFLARE_ACCOUNT_ID: 'test-account',
  DEPLOY_SOURCE_SHA: 'a'.repeat(40),
  AIG_GENERATION_AUTH_KEY: 'test-generation-center-auth-key-32-characters',
  AIG_MODELS_CONFIG: JSON.stringify({
    'Image-Creator': {
      policy: 'default',
      visibility: 'internal',
      ui_visible: false,
      group: 'image',
      modalities: { input: ['text'], output: ['image'] },
    },
  }),
  AIG_POLICIES_CONFIG: '{}',
  AIG_TIER1_NODES_01: JSON.stringify([
    { id: 'image-1', provider: 'openai-image', base_url: 'https://api.example.invalid', models: { 'Image-Creator': 'gpt-image-1' } },
  ]),
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'image-1': 'mock-credential-no-network' }),
};
const imagePack = buildGenerationCenterDeployment(generationImage);
assert.equal(imagePack.nodes, 1);
assert.equal(imagePack.config.name, 'ai-generation-center');
assert.equal(imagePack.config.workers_dev, false);
assert.equal(imagePack.config.vars.AIG_BUILD_SHA, generationImage.DEPLOY_SOURCE_SHA);
for (const key of ['routes', 'triggers', 'services', 'd1_databases', 'kv_namespaces']) assert.equal(imagePack.config[key], undefined);
assert.equal(imagePack.config.vars.AIG_GENERATION_AUTH_KEY, undefined);
assert.equal(imagePack.config.vars.AIG_TIER1_CREDENTIALS_01, undefined);
assert.equal(imagePack.secrets.AIG_GENERATION_AUTH_KEY, generationImage.AIG_GENERATION_AUTH_KEY);
assert.equal(imagePack.secrets.AIG_TIER1_CREDENTIALS_01, generationImage.AIG_TIER1_CREDENTIALS_01);
assert.throws(() => buildGenerationCenterDeployment({ ...generationImage, DEPLOY_SOURCE_SHA: 'main' }), /DEPLOY_SOURCE_SHA/);
assert.throws(() => buildGenerationCenterDeployment({ ...generationImage, AIG_TIER3_CREDENTIALS_01: '{}' }), /Legacy Tier 3/);
assert.throws(() => buildGenerationCenterDeployment({ ...generationImage, AIG_OAUTH_PROVIDERS: '{}' }), /subscription bindings/);
assert.throws(() => buildGenerationCenterDeployment({ ...generationImage, AIG_TIER1_CREDENTIALS_01: undefined }), /upstream credential/);
assert.throws(
  () =>
    buildGenerationCenterDeployment({
      ...generationImage,
      AIG_TIER1_NODES_01: JSON.stringify([
        { id: 'not-image', provider: 'openai', base_url: 'https://api.example.invalid', models: { 'Image-Creator': 'gpt-image-1' } },
      ]),
    }),
  /only static image-generation nodes/,
);
assert.equal(fs.existsSync(path.join(root, 'scripts/deploy-generation-center.sh')), false, 'Generation prepare must not imply an automatic deploy');

const centerBindingConfig = buildWranglerConfig({ AIG_INFERENCE_TARGET: 'ai-inference-center' });
assert.deepEqual(centerBindingConfig.services, [{ binding: 'AIG_INFERENCE_SERVICE', service: 'ai-inference-center' }]);
assert.equal(centerBindingConfig.vars.AIG_INFERENCE_TARGET, undefined);
assert.equal(centerBindingConfig.vars.AIG_INFERENCE_ACTIVE, 'true');
assert.equal(buildWranglerConfig({}).vars.AIG_INFERENCE_ACTIVE, undefined);
assert.equal(buildWranglerConfig({ AIG_INFERENCE_ACTIVE: 'true' }).vars.AIG_INFERENCE_ACTIVE, undefined);
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
assert.equal(bothCenters.vars.AIG_INFERENCE_ACTIVE, 'true');
assert.equal(bothCenters.vars.AIG_GENERATION_ACTIVE, 'true');

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
  AIG_INFERENCE_TARGET: 'ai-inference-center',
  AIG_GENERATION_TARGET: 'ai-generation-center',
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
  { name: 'AIG_INFERENCE_AUTH_KEY', type: 'secret_text' },
  { name: 'AIG_GENERATION_AUTH_KEY', type: 'secret_text' },
];
assert.equal(validateRemoteSecretInventory(remoteSecretNames, deployPrepared.config).credentialShards, 0);
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
  () => validateRemoteSecretInventory([...remoteSecretNames, { name: 'AIG_TIER1_CREDENTIALS_01', type: 'secret_text' }], deployPrepared.config),
  /must not retain upstream Provider credential shards/,
);
assert.throws(
  () => validateRemoteSecretInventory([...remoteSecretNames, { name: 'AIG_ACCESS_KEY_MAX', type: 'plain_text' }], deployPrepared.config),
  /invalid entry/,
);
const generationPrepared = validateDeploymentInputs(deployInputs);
assert.throws(
  () =>
    validateRemoteSecretInventory(
      remoteSecretNames.filter((secret) => secret.name !== 'AIG_GENERATION_AUTH_KEY'),
      generationPrepared.config,
    ),
  /AIG_GENERATION_AUTH_KEY/,
);
assert.throws(
  () =>
    validateRemoteSecretInventory(
      remoteSecretNames.filter((secret) => secret.name !== 'AIG_INFERENCE_AUTH_KEY'),
      generationPrepared.config,
    ),
  /AIG_INFERENCE_AUTH_KEY/,
);
assert.throws(() => validateRemoteSecretInventory(remoteSecretNames, buildWranglerConfig({})), /Both private center Service Bindings/);
assert.throws(() => validateDeploymentInputs({ ...deployInputs, AIG_INFERENCE_TARGET: '' }), /AIG_INFERENCE_TARGET/);
assert.throws(() => validateDeploymentInputs({ ...deployInputs, AIG_GENERATION_TARGET: '' }), /AIG_GENERATION_TARGET/);
assert.throws(
  () =>
    validateDeploymentInputs({
      ...deployInputs,
      AIG_TIER2_NODES_01: JSON.stringify([{ id: 'oauth-1', provider: 'anthropic', auth: 'oauth', models: { Chat: 'claude' } }]),
    }),
  /obsolete subscription auth node/,
);
assert.throws(() => validateDeploymentInputs({ ...deployInputs, AIG_TIER3_NODES_01: '[]' }), /Legacy Tier 3/);
assert.throws(
  () => validateRemoteSecretInventory([...remoteSecretNames, { name: 'AIG_TIER3_CREDENTIALS_01', type: 'secret_text' }], deployPrepared.config),
  /Retired Tier 3 or subscriber Secret bindings/,
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
assert.equal(
  await authorizeDeploymentHealth(deploymentHealthRequest, {
    AIG_DEPLOY_HEALTH_KEY: deploymentHealthKey,
    AIG_ACCESS_KEY_AGENT: deploymentHealthKey,
    AIG_ACCESS_MODELS_AGENT: '*',
  }),
  null,
  'a deployment health credential reused as an application access key must be rejected',
);
const weakHealthRequest = new Request('https://gateway.example.test/health', {
  headers: { authorization: 'Bearer too-short' },
});
assert.equal(await authorizeDeploymentHealth(weakHealthRequest, { AIG_DEPLOY_HEALTH_KEY: 'too-short' }), null);
assert.equal(
  await authorizeDeploymentHealth(deploymentHealthRequest, { AIG_DEPLOY_HEALTH_KEY: `${deploymentHealthKey}/` }),
  null,
  'invalid URL-unsafe deployment credentials must be rejected',
);
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
assert.ok(modelDiscoverySecretScope.every((name) => /^AIG_TIER[12]_CREDENTIALS_\d{2}$/.test(name)));
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
// An approved central production audit depends on this script's exit status.
// Verify the real Bash entrypoint, not a regex-only approximation: disabling
// deployment must never turn an unexecuted publish into a successful job.
for (const [setting, expectedExit, message] of [
  ['false', 77, /deployment is disabled/],
  ['invalid', 64, /must be true or false/],
]) {
  const result = spawnSync('bash', [path.join(root, 'scripts/deploy.sh')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, AIG_IS_DEPLOY_ENABLED: setting, DEPLOY_SOURCE_SHA: '' },
  });
  assert.equal(result.error, undefined, 'Disabled deploy must execute Bash without external API access');
  assert.equal(result.status, expectedExit, 'Unexecuted deploy must never return a successful exit status');
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stdout, /Deployment complete|deployment completed/i);
}
assert.match(deployScript, /persistent-deployment\.mjs verify-secrets/);
assert.match(deployScript, /secret list/);
assert.doesNotMatch(deployScript, /--secrets-file|gateway-secrets\.json/);
assert.match(deployScript, /cloudflare-wrangler\.mjs deploy/);
assert.match(deployScript, /cloudflare-wrangler\.mjs rollback/);
assert.match(deployScript, /persistent-deployment\.mjs health-check/);
assert.match(deployScript, /DEPLOY_SOURCE_SHA/);
assert.ok(deployScript.includes('deployment-recovery.mjs snapshot'));
assert.ok(deployScript.includes('deployment-recovery.mjs capture-published'));
assert.ok(deployScript.includes('deployment-recovery.mjs rollback-target'));
assert.ok(deployScript.includes('deployment-recovery.mjs verify-restored'));
assert.ok(deployScript.includes('deployment-recovery.mjs verify-published'));
assert.match(deployScript, /--message "action-worker:deploy:\$DEPLOY_SOURCE_SHA"/);
assert.match(deployScript, /rollback "\$rollback_version"/);
assert.equal(deployScript.includes('health-check || true'), false);
assert.equal(deployScript.includes('cloudflare-wrangler.mjs rollback --config'), false);

// Provider deployment identities are independent of the public /health build SHA.
// Requiring both catches mistaken restores and prevents an unpinned Wrangler
// rollback from selecting a different previously uploaded version.
const baselineVersion = '11111111-1111-4111-8111-111111111111';
const baselineDeployment = '22222222-2222-4222-8222-222222222222';
const publishedVersion = '33333333-3333-4333-8333-333333333333';
const publishedDeployment = '44444444-4444-4444-8444-444444444444';
const restoredDeployment = '55555555-5555-4555-8555-555555555555';
const unrelatedVersion = '66666666-6666-4666-8666-666666666666';
const knownAccount = 'a'.repeat(32);
const knownBuild = 'b'.repeat(40);
const deployedBuild = 'c'.repeat(40);
const activeResponse = (deploymentId, versionId, message = null, percent = 100) => ({
  success: true,
  result: {
    deployments: [
      {
        id: deploymentId,
        versions: [{ percentage: percent, version_id: versionId }],
        annotations: message === null ? {} : { 'workers/message': message },
      },
    ],
  },
});
const baselineActive = parseActiveDeployment(activeResponse(baselineDeployment, baselineVersion));
const publishedActive = parseActiveDeployment(activeResponse(publishedDeployment, publishedVersion, `action-worker:deploy:${deployedBuild}`));
const restoredActive = parseActiveDeployment(activeResponse(restoredDeployment, baselineVersion));
assert.equal(baselineActive.version_id, baselineVersion);
for (const invalid of [
  { success: false, result: { deployments: [] } },
  { success: true, result: { deployments: [] } },
  activeResponse(baselineDeployment, baselineVersion, null, 50),
  {
    success: true,
    result: {
      deployments: [
        {
          id: baselineDeployment,
          versions: [
            { percentage: 50, version_id: baselineVersion },
            { percentage: 50, version_id: publishedVersion },
          ],
        },
      ],
    },
  },
  activeResponse('invalid', baselineVersion),
  activeResponse(baselineDeployment, 'invalid'),
]) {
  assert.throws(() => parseActiveDeployment(invalid), /deployment|version/i);
}
const baselineRecord = establishRecoveryBaseline(baselineActive, baselineActive, knownBuild, knownAccount);
assert.throws(() => establishRecoveryBaseline(baselineActive, publishedActive, knownBuild, knownAccount), /changed|unverified/);
assert.throws(() => establishRecoveryBaseline(baselineActive, baselineActive, 'short', knownAccount), /changed|unverified/);
assert.throws(() => recordPublishedDeployment(baselineRecord, baselineActive, deployedBuild), /not verified/);
assert.throws(() => recordPublishedDeployment(baselineRecord, restoredActive, deployedBuild), /not verified/);
assert.throws(
  () =>
    recordPublishedDeployment(
      baselineRecord,
      parseActiveDeployment(activeResponse(publishedDeployment, publishedVersion, 'different-source')),
      deployedBuild,
    ),
  /not verified/,
);
const withPublished = recordPublishedDeployment(baselineRecord, publishedActive, deployedBuild);
assert.equal(guardedRollbackTarget(withPublished, publishedActive), baselineVersion);
assert.equal(confirmPublishedIdentity(withPublished, publishedActive), undefined);
assert.throws(() => recordPublishedDeployment(withPublished, publishedActive, deployedBuild), /not verified/);
assert.throws(() => guardedRollbackTarget(withPublished, parseActiveDeployment(activeResponse(restoredDeployment, unrelatedVersion))), /drifted/);
assert.throws(() => guardedRollbackTarget(withPublished, baselineActive), /drifted/);
assert.equal(confirmRestoredIdentity(withPublished, restoredActive, restoredActive, knownBuild), undefined);
for (const [first, second, build] of [
  [publishedActive, publishedActive, knownBuild],
  [restoredActive, restoredActive, deployedBuild],
  [restoredActive, publishedActive, knownBuild],
]) {
  assert.throws(() => confirmRestoredIdentity(withPublished, first, second, build), /not proven/);
}
let readCalls = 0;
const readOnlyCloudflare = async (url, options) => {
  readCalls += 1;
  assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${knownAccount}/workers/scripts/ai-gateway/deployments?per_page=1&page=1`);
  assert.equal(options?.method, 'GET');
  assert.equal(options?.redirect, 'error');
  assert.equal(options?.headers?.authorization, 'Bearer test-only-worker-inventory-token');
  assert.ok(options?.signal instanceof AbortSignal);
  return Response.json(activeResponse(baselineDeployment, baselineVersion));
};
assert.deepEqual(await fetchActiveDeployment(knownAccount, 'test-only-worker-inventory-token', readOnlyCloudflare), baselineActive);
assert.equal(readCalls, 1);
await assert.rejects(fetchActiveDeployment('wrong', 'not-a-token', readOnlyCloudflare), /account and token/);
assert.equal(readCalls, 1);

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
assert.deepEqual(redistributeUnusedTierAttempts({ 1: 3, 2: 1 }, 1, 2, policy), { 1: 3, 2: 3 });
assert.deepEqual(redistributeUnusedTierAttempts({ 1: 3, 2: 1 }, 2, 2, policy), { 1: 3, 2: 1 });
assert.deepEqual(redistributeUnusedTierAttempts({ 1: 3, 2: 1 }, 1, 2, { maxAttempts: 5, tierAttempts: { tier2: 1 } }), { 1: 3, 2: 1 });
assert.deepEqual(redistributeUnusedTierAttempts({ 1: 3, 2: 1 }, 1, 0, policy), { 1: 3, 2: 1 });
assert.throws(() => assertNodesArray([{ id: 'sub', provider: 'anthropic', auth: 'oauth', models: {} }], 'tier-2', 2), /obsolete subscription auth/);

console.log('Deployment configuration check passed.');
