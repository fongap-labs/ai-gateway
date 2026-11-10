#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Local contract checks for the read-only two-Tier cutover planner.

import assert from 'node:assert/strict';
import { planTwoTierCutover } from './tier-cutover-plan.mjs';

const CUTOVER_MODEL = 'cutover-contract-model';
const MOCK_UPSTREAM_MODEL = 'mock-upstream-model';

function node(id, extra = {}) {
  return { id, provider: 'openai', base_url: 'https://api.example.invalid', models: { [CUTOVER_MODEL]: MOCK_UPSTREAM_MODEL }, ...extra };
}

const tiers = {
  1: [node('free-a')],
  2: [node('static-old'), node('subscriber', { auth: 'oauth' })],
  3: [node('paid-old')],
};
const credentialIndex = { tier1: ['free-a'], tier2: ['static-old'], tier3: ['paid-old'] };
const modelCatalog = { [CUTOVER_MODEL]: { policy: 'default' } };
const baselineInput = JSON.stringify({ tiers, credentialIndex });
function plan(overrides = {}) {
  return planTwoTierCutover({ tiers, credentialIndex, policies: {}, modelCatalog, ...overrides });
}

const base = plan();
assert.equal(base.preflight_passed, true);
assert.deepEqual(base.source_counts, { tier1: 1, tier2: 2, tier3: 1 });
assert.deepEqual(base.target_counts, { tier1: 1, tier2: 2 });
assert.equal(base.node_moves.find((move) => move.node_id === 'paid-old')?.target_tier, 2);
assert.equal(base.node_moves.find((move) => move.node_id === 'static-old')?.action, 'retain_static_token');
assert.equal(base.retired_oauth_nodes[0]?.node_id, 'subscriber');
assert.equal(base.retired_oauth_nodes[0]?.retired_model_mapping.logical_model_count, 1);
assert.equal(base.model_catalog.valid, true);
assert.equal(base.unclassified_source_node_count, 0);
assert.match(base.model_catalog.fingerprint_sha256, /^[a-f0-9]{64}$/);
assert.match(base.node_moves[0]?.model_mapping.mapping_fingerprint_sha256, /^[a-f0-9]{64}$/);
assert.ok(!JSON.stringify(base).includes(MOCK_UPSTREAM_MODEL), 'upstream model names must not appear in the redacted plan');
assert.equal(JSON.stringify({ tiers, credentialIndex }), baselineInput, 'Preflight must not mutate source config');

function blocked(report, kind) {
  assert.equal(report.preflight_passed, false, kind);
  assert.ok(report.blockers.length > 0, kind);
}

blocked(plan({ policies: null }), 'Policy inventory must be explicit');
blocked(plan({ tiers: { 1: tiers[1], 2: tiers[2] }, credentialIndex }), 'Old Tier 3 inventory must be explicit');
blocked(plan({ credentialIndex: null }), 'Credential index is required');
blocked(plan({ modelCatalog: null }), 'Model catalog inventory must be explicit');
blocked(plan({ credentialIndex: { ...credentialIndex, tier3: [] } }), 'Unaccounted paid Provider credential must block cutover');
blocked(plan({ credentialIndex: { ...credentialIndex, tier3: ['static-old'] } }), 'Duplicate credential owner must block cutover');
blocked(plan({ tiers: { ...tiers, 3: [node('static-old')] } }), 'Duplicate target node ID must block cutover');
blocked(
  plan({ policies: { default: { tier_attempts: { tier2: 1, tier3: 2 } } } }),
  'Old paid and subscription-tier attempt limits require an explicit policy decision',
);
blocked(plan({ policies: { default: { hedge: { tiers: ['tier3'] } } } }), 'Hedge policy must be redefined for two tiers');
blocked(
  plan({ tiers: { 1: tiers[1], 2: [node('static-old', { credential: 'must-never-print' })], 3: tiers[3] } }),
  'Inline Provider secrets must be rejected',
);
const leaking = plan({ tiers: { 1: tiers[1], 2: [node('static-old', { credential: 'must-never-print' })], 3: tiers[3] } });
assert.ok(!JSON.stringify(leaking).includes('must-never-print'), 'Diagnostics must never print credential material');

const oauthCredential = plan({ credentialIndex: { tier1: ['free-a'], tier2: ['static-old', 'subscriber'], tier3: ['paid-old'] } });
blocked(oauthCredential, 'Retired OAuth nodes cannot receive static credential shards');

const duplicateTrimmedId = plan({
  tiers: { 1: [node('free-a')], 2: [node('free-a ')], 3: [] },
  credentialIndex: { tier1: ['free-a'], tier2: ['free-a'], tier3: [] },
});
assert.ok(
  duplicateTrimmedId.blockers.some((item) => item.includes('Duplicate node ID free-a')),
  'Trim-equivalent node IDs must conflict',
);

const modelCollision = plan({
  tiers: {
    1: [node('free-a', { models: { [CUTOVER_MODEL]: 'mock-target-a', [CUTOVER_MODEL.toUpperCase()]: 'mock-target-b' } })],
    2: [],
    3: [],
  },
  credentialIndex: { tier1: ['free-a'], tier2: [], tier3: [] },
});
assert.ok(modelCollision.blockers.some((item) => item.includes('ambiguous or invalid model mappings')));
assert.ok(!JSON.stringify(modelCollision).includes('mock-target-a'), 'Conflicting model values must not enter the report');

const malformedPolicy = plan({ policies: { default: { hedge: 'malformed' } } });
assert.ok(malformedPolicy.blockers.some((item) => item.includes('shared runtime policy validator')));

const unknownModelPolicy = plan({ modelCatalog: { [CUTOVER_MODEL]: { policy: 'missing-policy' } } });
assert.ok(unknownModelPolicy.blockers.some((item) => item.includes('unresolved policy reference')));
assert.equal(unknownModelPolicy.model_catalog.valid, false);
assert.equal(unknownModelPolicy.model_catalog.unresolved_policy_reference_count, 1);
assert.ok(!JSON.stringify(unknownModelPolicy).includes(CUTOVER_MODEL), 'logical model names must not enter diagnostics');

const invalidNode = plan({
  tiers: { 1: [node('free-a', { models: { [CUTOVER_MODEL]: '' } })], 2: [], 3: [] },
  credentialIndex: { tier1: ['free-a'], tier2: [], tier3: [] },
});
assert.equal(invalidNode.unclassified_source_node_count, 1);
assert.ok(invalidNode.blockers.some((item) => item.includes('no safe migration action')));

const legacyBudget = plan({ policies: { default: { max_attempts: 5, tier_attempts: { tier1: 1, tier2: 2, tier3: 2 } } } });
assert.deepEqual(legacyBudget.policy_reviews[0]?.legacy_tier_attempts, { tier2: 2, tier3: 2 });
assert.equal(legacyBudget.policy_reviews[0]?.action, 'review_and_rewrite_explicitly');

console.log(
  'Two-Tier cutover preflight contracts passed (redacted model preservation, migration mapping, inventory, credential references and policy conflicts).',
);
