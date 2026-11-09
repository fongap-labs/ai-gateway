#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Strict two-Tier source/runtime contract. No network, credentials or deployment.

import assert from 'node:assert/strict';
import { preflight } from '../apps/gateway/preflight.ts';
import { TIER_ORDER } from '../apps/gateway/policy/router.ts';
import { redistributeUnusedTierAttempts } from '../apps/gateway/scheduling/tier-policy.ts';
import { loadExecutionConfig, loadGatewayConfig } from '../src/config/nodes.ts';
import { getPoliciesConfigDiagnostics } from '../src/config/policies.ts';
import { routingStrategyFor } from '../src/scheduler/routing-strategy.ts';

assert.deepEqual(TIER_ORDER, [1, 2], 'only free and API Token tiers participate in routing');
assert.equal(routingStrategyFor(1).id, 'p2c_ttft', 'the free tier retains its adaptive scheduler');
assert.equal(routingStrategyFor(2).id, 'priority_lru', 'the API Token tier uses the health-aware scheduler');

const originalCaps = { 1: 3, 2: 1 };
const flexiblePolicy = { maxAttempts: 5, tierAttempts: null };
assert.deepEqual(
  redistributeUnusedTierAttempts({ ...originalCaps }, 1, 2, flexiblePolicy),
  { 1: 3, 2: 3 },
  'unused free-tier attempts transfer to the paid API Token reserve',
);
assert.deepEqual(
  redistributeUnusedTierAttempts({ ...originalCaps }, 1, 2, { maxAttempts: 5, tierAttempts: { tier2: 1 } }),
  originalCaps,
  'explicit Token tier attempt caps are never relaxed',
);
assert.deepEqual(
  redistributeUnusedTierAttempts({ ...originalCaps }, 2, 2, flexiblePolicy),
  originalCaps,
  'Token tier is terminal; no third tier can receive unused attempts',
);

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
assert.equal(publicConfig.tiers[1][0]?.credential, '', 'public Gateway must not own free Provider credentials');
assert.equal(publicConfig.tiers[2][0]?.credential, '', 'public Gateway must not own paid Provider credentials');
assert.equal(centerConfig.tiers[2][0]?.credential, 'paid-test-credential', 'private center resolves the API Token credential');
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
for (const [legacySetting, value] of [
  ['AIG_OAUTH_PROVIDERS', '{}'],
  ['AIG_IS_SUBSCRIPTION_ENABLED', 'false'],
  ['AIG_TOKEN_ENCRYPTION_KEY', 'fake-old-encryption-key'],
]) {
  const legacy = loadGatewayConfig({ ...base, [legacySetting]: value });
  assert.equal(legacy.status, 'invalid', `retired membership setting ${legacySetting} must fail closed`);
  assert.equal(legacy.nodesUsable, 0, 'membership settings must never leave partial API Token capacity serving');
  assert.ok(legacy.diagnostics.some((line) => line.includes(legacySetting)));
}

const oldPrivateSecrets = loadExecutionConfig({
  ...base,
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ 'token-a': 'new-token-only' }),
  AIG_TIER3_CREDENTIALS_01: JSON.stringify({ 'old-paid': 'fake-old-token' }),
});
assert.equal(oldPrivateSecrets.status, 'invalid', 'old paid credentials cannot be skipped by private-center load');
assert.equal(oldPrivateSecrets.nodesUsable, 0);

// The 404 guard must precede authorization, subscriptions and private-center
// execution. A retired OAuth callback must never exchange, refresh or persist
// tokens, even if an operator forgot to remove historical configuration.
for (const method of ['GET', 'POST']) {
  for (const uri of ['/oauth/start', '/oauth/callback', '/oauth/refresh']) {
    const request = new Request(`https://gateway.example.invalid${uri}`, { method });
    const terminal = await preflight(request, { ...base, AIG_OAUTH_PROVIDERS: '{}' }, { waitUntil() { throw new Error('Legacy OAuth must not schedule work'); } });
    assert.equal(terminal.ok, false, `${method} ${uri} must terminate in Gateway`);
    assert.equal(terminal.response.status, 404, `${method} ${uri} must remain unavailable`);
    assert.equal(terminal.response.headers.get('set-cookie'), null, 'OAuth cookies must not be created');
  }
}

const twoTierPolicy = {
  ...base,
  AIG_POLICIES_CONFIG: JSON.stringify({
    default: { max_attempts: 4, tier_attempts: { tier1: 2, tier2: 2 }, hedge: { enabled: true, tiers: ['tier1', 'tier2'] } },
  }),
};
assert.deepEqual(getPoliciesConfigDiagnostics(twoTierPolicy), []);
assert.equal(loadGatewayConfig(twoTierPolicy).ready, true);

console.log('Two-Tier runtime contracts passed (routing, metadata, private credentials and fail-closed migration guards).');
