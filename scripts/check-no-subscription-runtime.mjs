#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Old membership-subscription execution is removed. Keep only fail-closed
// rejection of legacy inputs, never a second credential or provider path.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const retired = [
  'apps/gateway/oauth/routes.ts',
  'apps/inference/credentials/resolve.ts',
  'packages/oauth/crypto.ts',
  'packages/oauth/token-store.ts',
  'src/oauth/crypto.ts',
  'src/oauth/provider-configs.ts',
  'src/oauth/resolve.ts',
  'src/oauth/routes.ts',
  'src/oauth/token-store.ts',
  'src/subscription/anthropic.ts',
  'src/subscription/google-wire.ts',
  'src/subscription/google.ts',
  'src/subscription/index.ts',
  'src/subscription/openai.ts',
  'src/subscription/quota-hints.ts',
  'src/subscription/types.ts',
];
for (const file of retired) {
  assert.equal(existsSync(join(root, file)), false, 'Retired member-subscription source cannot be restored: ' + file);
}
function read(path) {
  return readFileSync(join(root, path), 'utf8');
}
const runtimeVars = read('packages/config-core/runtime-vars.ts');
const nodeType = read('packages/contracts/runtime-node.ts');
const providers = read('src/providers/types.ts');
const deployment = read('scripts/github-deployment-config.mjs');
for (const [file, source] of [
  ['runtime-vars', runtimeVars],
  ['node type', nodeType],
  ['provider adapters', providers],
]) {
  for (const marker of ['AIG_IS_SUBSCRIPTION_ENABLED', 'AIG_OAUTH_ADMIN_GROUPS', 'AIG_OAUTH_PROVIDERS', 'AIG_TOKEN_ENCRYPTION_KEY']) {
    assert.ok(!source.includes(marker), file + ' must not expose retired subscription marker ' + marker);
  }
}
assert.ok(deployment.includes('Retired subscription bindings must be removed'), 'Deployment must fail closed on retired subscription bindings');
assert.ok(!nodeType.includes("auth?: 'oauth'"), 'Runtime nodes may not declare subscription OAuth');
assert.ok(!providers.includes('subscription?:'), 'Provider registry may not expose subscription adapter');
const preflight = read('apps/gateway/preflight.ts');
assert.ok(preflight.includes("pathname.startsWith('/oauth/')"), 'Legacy OAuth routes must fail closed');
assert.ok(preflight.includes('status: 404') || preflight.includes('404'), 'Retired OAuth onboarding must return 404');
const nodeConfig = read('packages/config-core/nodes.ts');
assert.ok(nodeConfig.includes("Object.hasOwn(rawNode, 'auth')"), 'Old OAuth node input must be explicitly rejected');
assert.ok(nodeConfig.includes("status: 'invalid'"), 'Migration errors must invalidate the whole node configuration');
console.log('No legacy Tier 2 member-subscription runtime remains; deprecated configuration and routes fail closed.');
