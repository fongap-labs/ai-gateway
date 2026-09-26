#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deployManifest = JSON.parse(readFileSync(join(root, '.github/deploy.json'), 'utf8'));
const deployScript = readFileSync(join(root, 'scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');

assert.equal(existsSync(join(root, '.github/workflows/deploy.yml')), false);
assert.deepEqual(deployManifest, {
  schema_version: '1',
  adapter: 'source-script',
  automatic: true,
  ignore_docs_only: true,
  runner_profile: 'production-deploy',
  environment: 'production',
  entrypoint: 'scripts/deploy.sh',
});
assert.match(deployScript, /DEPLOY_SOURCE_SHA/);
assert.match(deployScript, /AIG_IS_DEPLOY_ENABLED/);
assert.match(deployScript, /cloudflare-wrangler\.mjs deploy/);
assert.match(deployScript, /cloudflare-wrangler\.mjs rollback/);
assert.match(deployScript, /github-deployment-config\.mjs health-check/);
assert.doesNotMatch(deployScript, /AW_DISPATCH_TOKEN|AW_CONTROL_TOKEN|AW_ADMIN_TOKEN/);
assert.doesNotMatch(deployScript, /wrangler@\d+\.\d+\.\d+/);

assert.match(ci, /run-central-ci-ref/);
assert.match(ci, /AW_DISPATCH_TOKEN/);
assert.doesNotMatch(ci, /npm\s+run/);

console.log('deployment-workflow-contract: source-owned deploy contract passed');
