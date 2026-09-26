#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const deploy = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');

assert.match(deploy, /AIG_IS_DEPLOY_ENABLED/);
assert.match(deploy, /== "false"/);
assert.match(deploy, /exit 0/);
assert.match(deploy, /cloudflare-wrangler\.mjs deploy/);
assert.doesNotMatch(deploy, /AW_DISPATCH_TOKEN|AW_CONTROL_TOKEN|AW_ADMIN_TOKEN/);
assert.doesNotMatch(deploy, /wrangler@\d+\.\d+\.\d+/);

console.log('deploy kill-switch contract tests passed.');
