#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Strict two-Tier source/runtime contract. No network, credentials or deployment.

import assert from 'node:assert/strict';
import { TIER_ORDER } from '../apps/gateway/policy/router.ts';
import { loadExecutionConfig, loadGatewayConfig } from '../src/config/nodes.ts';
import { getPoliciesConfigDiagnostics } from '../src/config/policies.ts';

assert.deepEqual(TIER_ORDER, [1, 2], 'only free and API Token tiers participate in routing');

function node(id, fields = {}) {
  return { id, provider: 'openai', base_url: 'https://api.example.invalid/v1', models: { 'Code-Pro': 'upstream-model' }, ...fields };
}
const base = {
  AIG_ACCESS_KEY_AIR: 'local-contract-access-key',
  AIG_TIER1_NODES_01: JSON.stringify([node('free-a')]),
  AIG_TIER2_NODES_01: JSON.stringify([node('token-a')]),
};
const publicConfig = loadGatewayConfig({ ...base });
assert.equal(publicConfig.ready, true);
assert.equal(publicConfig.hasConfigErrors, false);
assert.deepEqual(Object.keys(publicConfig.tiers).sort(), ['1', '2']);
assert.deepEqual(
  publicConfig.tiers[1].map((n) => n.id),
  ['free-a'],
);
assert.deepEqual(
  publicConfig.tiers[2].map((n) => n.id),
  ['token-a'],
);
const centerConfig = loadExecutionConfig({
  ...base,
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'free-a': 'free-test-credential' }),
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ 'token-a': 'paid-test-credential' }),
});
assert.equal(centerConfig.ready, true);
assert.deepEqual(
  centerConfig.tiers[2].map((n) => n.id),
  ['token-a'],
);

for (const oldBinding of ['AIG_TIER3_NODES_01', 'AIG_TIER3_CREDENTIALS_01']) {
  const env = { ...base, [oldBinding]: oldBinding.includes('NODES') ? '[]' : '{}' };
  const result = loadGatewayConfig(env);
  assert.equal(result.ready, false, 'legacy binding must reject the entire configuration');
  assert.equal(result.status, 'invalid');
  assert.equal(result.nodesUsable, 0);
  assert.ok(result.diagnostics.some((line) => line.includes('legacy Tier 3')));
}
for (const oldPolicy of [
  { default: { max_attempts: 4, tier_attempts: { tier1: 1, tier3: 2 } } },
  { default: { hedge: { enabled: true, tiers: ['tier3'] } } },
]) {
  const env = { ...base, AIG_POLICIES_CONFIG: JSON.stringify(oldPolicy) };
  const result = loadGatewayConfig(env);
  assert.equal(result.ready, false, 'legacy policy must fail closed, not run on a partial pool');
  assert.equal(result.status, 'invalid');
  assert.ok(getPoliciesConfigDiagnostics(env).length > 0);
}
const oldOAuth = loadGatewayConfig({
  ...base,
  AIG_TIER2_NODES_01: JSON.stringify([node('token-a'), node('subscription-a', { auth: 'oauth' })]),
});
assert.equal(oldOAuth.ready, false, 'old subscriber capacity must not be silently treated as an API Token');
assert.equal(oldOAuth.status, 'invalid');
assert.equal(oldOAuth.nodesUsable, 0);
assert.ok(oldOAuth.diagnostics.some((line) => line.includes('subscription auth marker')));

const twoTierPolicy = {
  ...base,
  AIG_POLICIES_CONFIG: JSON.stringify({
    default: { max_attempts: 4, tier_attempts: { tier1: 2, tier2: 2 }, hedge: { enabled: true, tiers: ['tier1', 'tier2'] } },
  }),
};
assert.deepEqual(getPoliciesConfigDiagnostics(twoTierPolicy), []);
assert.equal(loadGatewayConfig(twoTierPolicy).ready, true);

console.log('Two-Tier runtime contracts passed (routing, metadata, private credentials and fail-closed migration guards).');
