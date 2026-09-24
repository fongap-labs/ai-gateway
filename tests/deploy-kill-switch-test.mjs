#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

assert.match(deploy, /run-ai-gateway-deploy/);
assert.match(deploy, /AW_DISPATCH_TOKEN/);
assert.doesNotMatch(deploy, /AIG_IS_DEPLOY_ENABLED/);
assert.doesNotMatch(deploy, /CLOUDFLARE_API_TOKEN/);
assert.doesNotMatch(deploy, /wrangler@/);

console.log('deploy ownership contract tests passed.');
