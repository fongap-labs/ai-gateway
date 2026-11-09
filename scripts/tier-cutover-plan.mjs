#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Dry-run preflight for the one-time three-to-two Tier configuration cutover.
// This tool does not fetch, decrypt, print, or write any Provider credentials.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodesArray } from './node-config-shards.mjs';

const TIERS = [1, 2, 3];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const POLICY_NAME = /^[a-zA-Z0-9._-]{1,80}$/;
const ALLOWED_OPTIONS = new Set(['tier1', 'tier2', 'tier3', 'credential-index', 'policies']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safePolicyName(name) {
  return POLICY_NAME.test(name) ? name : '(invalid policy name)';
}

function tierNodes(tiers, tier) {
  return tiers?.[tier] ?? tiers?.[`tier${tier}`] ?? [];
}

export function planTwoTierCutover({ tiers = {}, credentialIndex = null, policies = null } = {}) {
  const blockers = [];
  const warnings = [];
  const nodeMoves = [];
  const retiredOauth = [];
  const policyReviews = [];
  const seen = new Map();
  const sourceCounts = { tier1: 0, tier2: 0, tier3: 0 };
  const targetCounts = { tier1: 0, tier2: 0 };

  for (const tier of TIERS) {
    if (!Object.hasOwn(tiers, tier) && !Object.hasOwn(tiers, 'tier' + tier)) {
      blockers.push('tier' + tier + ': source inventory not supplied; provide [] explicitly when empty');
    }
  }

  for (const tier of TIERS) {
    const label = 'tier' + tier;
    const nodes = tierNodes(tiers, tier);
    if (!Array.isArray(nodes)) {
      blockers.push(label + ': expected an array of nodes');
      continue;
    }
    sourceCounts[label] = nodes.length;
    try {
      assertNodesArray(nodes, 'tier-' + tier, tier);
    } catch {
      // The original validation error may contain operator-supplied values.
      blockers.push(label + ': invalid source node configuration; run config:check');
      continue;
    }
    for (const node of nodes) {
      const previous = seen.get(node.id);
      if (previous !== undefined) {
        blockers.push('Duplicate node ID ' + node.id + ' in tier' + previous + ' and ' + label);
        continue;
      }
      seen.set(node.id, tier);
      if (node.auth === 'oauth') {
        retiredOauth.push({ node_id: node.id, source_tier: tier, action: 'retire_subscription_node' });
        continue;
      }
      const targetTier = tier === 1 ? 1 : 2;
      targetCounts['tier' + targetTier] += 1;
      nodeMoves.push({
        node_id: node.id,
        source_tier: tier,
        target_tier: targetTier,
        action: tier === 1 ? 'retain_free' : tier === 2 ? 'retain_static_token' : 'promote_paid_token',
        source_credential_prefix: 'AIG_TIER' + tier + '_CREDENTIALS_',
        target_credential_prefix: 'AIG_TIER' + targetTier + '_CREDENTIALS_',
      });
    }
  }

  if (nodeMoves.length === 0) blockers.push('No static-credential nodes are available for the target configuration');

  if (credentialIndex === null) {
    blockers.push('Credential ID index not supplied; source and destination credential ownership cannot be verified');
  } else if (!plainObject(credentialIndex) || Object.keys(credentialIndex).some((key) => !TIERS.some((t) => key === 'tier' + t))) {
    blockers.push('Credential index must be an object with only tier1, tier2 and tier3 ID arrays');
  } else {
    const credentialOwners = new Map();
    for (const tier of TIERS) {
      const key = 'tier' + tier;
      const ids = credentialIndex[key];
      if (!Array.isArray(ids)) {
        blockers.push('Credential index ' + key + ' must be an array of node IDs');
        continue;
      }
      for (const id of ids) {
        if (typeof id !== 'string' || !ID.test(id)) {
          blockers.push(key + ': invalid credential node identifier');
          continue;
        }
        const previous = credentialOwners.get(id);
        if (previous !== undefined) {
          blockers.push('Credential node ID ' + id + ' has multiple source assignments');
          continue;
        }
        credentialOwners.set(id, tier);
      }
    }
    for (const [id, tier] of credentialOwners) {
      const nodeTier = seen.get(id);
      if (nodeTier === undefined) {
        blockers.push('Credential metadata for ' + id + ' has no matching configured node');
      } else if (tier !== nodeTier) {
        blockers.push('Credential tier mismatch for ' + id + ': index tier' + tier + ', node tier' + nodeTier);
      } else if (retiredOauth.some((node) => node.node_id === id)) {
        blockers.push('OAuth node ' + id + ' unexpectedly has a static credential assignment');
      }
    }
    for (const move of nodeMoves) {
      if (credentialOwners.get(move.node_id) !== move.source_tier) {
        blockers.push('Static credential source for ' + move.node_id + ' has not been verified');
      }
    }
  }

  if (policies === null) blockers.push('Policy inventory not supplied; pass --policies with {} when no custom policies exist');
  if (policies !== null) {
    if (!plainObject(policies)) {
      blockers.push('Policies must be an object keyed by policy name');
    } else {
      for (const [name, policy] of Object.entries(policies)) {
        const safe = safePolicyName(name);
        if (!plainObject(policy)) {
          blockers.push('Policy ' + safe + ' must be an object');
          continue;
        }
        const attempts = policy.tier_attempts;
        const hedgeTiers = policy.hedge?.tiers;
        if (attempts !== undefined && attempts !== null && !plainObject(attempts)) {
          blockers.push('Policy ' + safe + ' has malformed tier_attempts');
        }
        if (hedgeTiers !== undefined && !Array.isArray(hedgeTiers)) {
          blockers.push('Policy ' + safe + ' has malformed hedge.tiers');
        }
        const hasOldTwo = plainObject(attempts) && Object.hasOwn(attempts, 'tier2');
        const hasOldThree = plainObject(attempts) && Object.hasOwn(attempts, 'tier3');
        const affectedHedge = Array.isArray(hedgeTiers) && hedgeTiers.some((value) => value === 'tier2' || value === 'tier3');
        if (hasOldTwo || hasOldThree || affectedHedge) {
          const reasons = [];
          if (hasOldTwo) reasons.push('old_tier2_attempt_limit');
          if (hasOldThree) reasons.push('old_tier3_attempt_limit');
          if (hasOldTwo && hasOldThree) reasons.push('limits_cannot_be_merged_implicitly');
          if (affectedHedge) reasons.push('hedge_tiers_require_review');
          policyReviews.push({ policy: safe, reasons, action: 'review_and_rewrite_explicitly' });
          blockers.push('Policy ' + safe + ' requires explicit two-tier budget/hedge review');
        }
      }
    }
  }

  warnings.push('Plan is a read-only preview; no environment variables, Secrets, policies, D1 data or deployments are changed');
  warnings.push('Credential index contains node IDs only; matching credential VALUES or duplicate secret material cannot be verified here');
  warnings.push('Remove old Tier 3 variables only after the new Tier 2 nodes and private-center credential shards are validated');

  return {
    schema_version: 1,
    mode: 'three_to_two_tier_preflight',
    preflight_passed: blockers.length === 0,
    source_counts: sourceCounts,
    target_counts: targetCounts,
    node_moves: nodeMoves,
    retired_oauth_nodes: retiredOauth,
    policy_reviews: policyReviews,
    blockers,
    warnings,
  };
}

function argumentsFrom(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !ALLOWED_OPTIONS.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(args, key)) {
      throw new Error('Invalid or repeated option; see the documented --tier1/--tier2/--tier3/--credential-index/--policies flags');
    }
    args[key] = argv[i + 1];
  }
  if (!TIERS.some((tier) => args['tier' + tier])) {
    throw new Error('Supply at least one --tier1/--tier2/--tier3 source file');
  }
  return args;
}

function readJson(file, label) {
  try {
    let content = readFileSync(resolve(file), 'utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return JSON.parse(content);
  } catch {
    // Do not echo JSON parse errors: operators might pass confidential files.
    throw new Error('Unable to read valid JSON from ' + label + ' file');
  }
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const tiers = Object.fromEntries(TIERS.filter((tier) => args['tier' + tier]).map((tier) => [tier, readJson(args['tier' + tier], 'tier' + tier)]));
  const credentialIndex = args['credential-index'] ? readJson(args['credential-index'], 'credential-index') : null;
  const policies = args.policies ? readJson(args.policies, 'policies') : null;
  const result = planTwoTierCutover({ tiers, credentialIndex, policies });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.preflight_passed) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Cutover preflight failed: ' + error.message);
    process.exitCode = 2;
  });
}
