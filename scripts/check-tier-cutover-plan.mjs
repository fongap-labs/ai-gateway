#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Local contract checks for the read-only two-Tier cutover planner.

import assert from 'node:assert/strict';
import { planTwoTierCutover } from './tier-cutover-plan.mjs';

function node(id, extra = {}) {
  return { id, provider: 'openai', base_url: 'https://api.example.invalid', models: { 'code-pro': 'model' }, ...extra };
}

const tiers = {
  1: [node('free-a')],
  2: [node('static-old'), node('subscriber', { auth: 'oauth' })],
  3: [node('paid-old')],
};
const credentialIndex = { tier1: ['free-a'], tier2: ['static-old'], tier3: ['paid-old'] };
const baselineInput = JSON.stringify({ tiers, credentialIndex });
const base = planTwoTierCutover({ tiers, credentialIndex, policies: {} });
assert.equal(base.preflight_passed, true);
assert.deepEqual(base.source_counts, { tier1: 1, tier2: 2, tier3: 1 });
assert.deepEqual(base.target_counts, { tier1: 1, tier2: 2 });
assert.equal(base.node_moves.find((move) => move.node_id === 'paid-old')?.target_tier, 2);
assert.equal(base.node_moves.find((move) => move.node_id === 'static-old')?.action, 'retain_static_token');
assert.equal(base.retired_oauth_nodes[0]?.node_id, 'subscriber');
assert.ok(!JSON.stringify(base).includes('https://api.example.invalid'), 'Provider URLs must not appear in the plan');
assert.equal(JSON.stringify({ tiers, credentialIndex }), baselineInput, 'Preflight must not mutate source config');

function blocked(report, kind) {
  assert.equal(report.preflight_passed, false, kind);
  assert.ok(report.blockers.length > 0, kind);
}

blocked(planTwoTierCutover({ tiers, credentialIndex }), 'Policy inventory must be explicit');
blocked(planTwoTierCutover({ tiers: { 1: tiers[1], 2: tiers[2] }, credentialIndex, policies: {} }), 'Old Tier 3 inventory must be explicit');
blocked(planTwoTierCutover({ tiers, policies: {} }), 'Credential index is required');
blocked(
  planTwoTierCutover({ tiers, credentialIndex: { ...credentialIndex, tier3: [] }, policies: {} }),
  'Unaccounted paid Provider credential must block cutover',
);
blocked(
  planTwoTierCutover({ tiers, credentialIndex: { ...credentialIndex, tier3: ['static-old'] }, policies: {} }),
  'Duplicate credential owner must block cutover',
);
blocked(
  planTwoTierCutover({
    tiers: { ...tiers, 3: [node('static-old')] },
    credentialIndex,
    policies: {},
  }),
  'Duplicate target node ID must block cutover',
);
blocked(
  planTwoTierCutover({ tiers, credentialIndex, policies: { default: { tier_attempts: { tier2: 1, tier3: 2 } } } }),
  'Old paid and subscription-tier attempt limits require an explicit policy decision',
);
blocked(
  planTwoTierCutover({ tiers, credentialIndex, policies: { default: { hedge: { tiers: ['tier3'] } } } }),
  'Hedge policy must be redefined for two tiers',
);
blocked(
  planTwoTierCutover({
    tiers: { 1: tiers[1], 2: [node('static-old', { credential: 'must-never-print' })], 3: tiers[3] },
    credentialIndex,
    policies: {},
  }),
  'Inline Provider secrets must be rejected',
);
const leaking = planTwoTierCutover({
  tiers: { 1: tiers[1], 2: [node('static-old', { credential: 'must-never-print' })], 3: tiers[3] },
  credentialIndex,
  policies: {},
});
assert.ok(!JSON.stringify(leaking).includes('must-never-print'), 'Diagnostics must never print credential material');

const oauthCredential = planTwoTierCutover({
  tiers,
  credentialIndex: { tier1: ['free-a'], tier2: ['static-old', 'subscriber'], tier3: ['paid-old'] },
  policies: {},
});
blocked(oauthCredential, 'Retired OAuth nodes cannot receive static credential shards');

console.log('Two-Tier cutover preflight contracts passed (redaction, mapping, inventory, credential and policy conflicts).');
