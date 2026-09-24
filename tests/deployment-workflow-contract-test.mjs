#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deploy = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8').replace(/\r\n/g, '\n');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');

assert.match(deploy, /workflow_dispatch:/);
assert.doesNotMatch(deploy, /workflow_run:|status:/);
assert.match(deploy, /Dispatch Central Deploy/);
assert.match(deploy, /AW_DISPATCH_TOKEN/);
assert.match(deploy, /run-ai-gateway-deploy/);
assert.match(deploy, /schema_version: "1"/);
assert.match(deploy, /source_repository/);
assert.match(deploy, /source_sha/);
assert.match(deploy, /refs\/heads\/main/);

for (const forbidden of [
  'CLOUDFLARE_API_TOKEN',
  'wrangler@',
  'd1 migrations',
  'Deploy Worker',
  'Rollback to previous Worker version',
  'AIG_TIER1_CREDENTIALS_01',
  'AIG_IS_DEPLOY_ENABLED',
]) {
  assert.equal(deploy.includes(forbidden), false, `business deploy bridge must not retain ${forbidden}`);
}

assert.match(ci, /run-central-ci-ref/);
assert.match(ci, /AW_DISPATCH_TOKEN/);
assert.doesNotMatch(ci, /npm\s+run/);

console.log('deployment-workflow-contract: central dispatch bridge passed');
