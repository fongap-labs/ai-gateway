#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Dry-run preflight for the one-time three-to-two Tier configuration cutover.
// This tool does not fetch, decrypt, print, or write any Provider credentials.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModelsConfigDiagnostics, loadModelsConfig } from '../src/config/models.ts';
import { getPoliciesConfigDiagnostics, loadPoliciesConfig } from '../src/config/policies.ts';
import { assertNodesArray } from './node-config-shards.mjs';

const TIERS = [1, 2, 3];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const POLICY_NAME = /^[a-zA-Z0-9._-]{1,80}$/;
const ALLOWED_OPTIONS = new Set(['tier1', 'tier2', 'tier3', 'credential-index', 'policies', 'model-catalog']);

const LEGACY_OAUTH_NODE_FIELDS = new Set(['id', 'provider', 'base_url', 'priority', 'models', 'auth']);

// This is an isolated historical input validator, not a runtime adapter.
// Only the old Tier 2 may contain membership OAuth nodes. It never opens an
// OAuth connection, decodes tokens, or publishes credential material.
function assertLegacyOauthNodes(nodes, tier) {
  if (tier !== 2 && nodes.length > 0) throw new Error('OAuth subscriptions were only supported in old Tier 2');
  for (const node of nodes) {
    if (
      typeof node.id !== 'string' ||
      !ID.test(node.id) ||
      typeof node.provider !== 'string' ||
      !node.provider.trim() ||
      node.auth !== 'oauth' ||
      !plainObject(node.models) ||
      Object.keys(node).some((field) => !LEGACY_OAUTH_NODE_FIELDS.has(field))
    ) {
      throw new Error('Invalid historical OAuth node metadata');
    }
    if (node.base_url !== undefined && (typeof node.base_url !== 'string' || !node.base_url.trim())) {
      throw new Error('Invalid historical OAuth base_url');
    }
    if (node.priority !== undefined && (!Number.isInteger(node.priority) || node.priority < 0)) {
      throw new Error('Invalid historical OAuth priority');
    }
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safePolicyName(name) {
  return POLICY_NAME.test(name) ? name : '(invalid policy name)';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function auditModelMappings(models, catalogNames = []) {
  if (!plainObject(models)) throw new Error('Model mappings must be an object.');
  const canonicalNames = new Map();
  for (const name of catalogNames) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const key = name.trim().toLowerCase();
    if (!canonicalNames.has(key)) canonicalNames.set(key, name.trim());
  }
  const normalized = new Map();
  for (const [rawName, rawUpstream] of Object.entries(models)) {
    const name = rawName.trim();
    if (!name || typeof rawUpstream !== 'string' || !rawUpstream.trim()) {
      throw new Error('Invalid logical-to-upstream model mapping.');
    }
    const canonical = canonicalNames.get(name.toLowerCase()) ?? name;
    const upstream = rawUpstream.trim();
    const previous = normalized.get(canonical);
    if (previous !== undefined && previous !== upstream) {
      throw new Error('Ambiguous logical-to-upstream model mapping.');
    }
    normalized.set(canonical, upstream);
  }
  const entries = [...normalized.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    source_entry_count: Object.keys(models).length,
    logical_model_count: entries.length,
    collapsed_case_alias_count: Object.keys(models).length - entries.length,
    wildcard: entries.length === 0,
    mapping_fingerprint_sha256: fingerprint(entries),
  };
}

function auditModelCatalog(modelCatalog, policies, blockers) {
  if (modelCatalog === null) {
    blockers.push('Model catalog inventory not supplied; pass --model-catalog with {} when no explicit catalog exists');
    return { supplied: false, valid: false, entry_count: 0, fingerprint_sha256: null };
  }
  if (!plainObject(modelCatalog)) {
    blockers.push('Model catalog must be an object keyed by logical model name');
    return { supplied: true, valid: false, entry_count: 0, fingerprint_sha256: null };
  }

  const env = {
    AIG_MODELS_CONFIG: JSON.stringify(modelCatalog),
    AIG_POLICIES_CONFIG: JSON.stringify(plainObject(policies) ? policies : {}),
  };
  const modelErrors = getModelsConfigDiagnostics(env);
  const policyNames = loadPoliciesConfig(env);
  const loadedModels = loadModelsConfig(env);
  const canonicalCatalogNames = new Map();
  let ambiguousCatalog = false;
  let unresolvedPolicyCount = 0;
  for (const name of Object.keys(loadedModels)) {
    const key = name.trim().toLowerCase();
    const previous = canonicalCatalogNames.get(key);
    if (previous !== undefined && stableJson(modelCatalog[previous]) !== stableJson(modelCatalog[name])) ambiguousCatalog = true;
    else if (previous === undefined) canonicalCatalogNames.set(key, name);
    const policy = loadedModels[name]?.policy?.policy;
    if (policy && !Object.hasOwn(policyNames, policy)) unresolvedPolicyCount += 1;
  }
  if (unresolvedPolicyCount > 0) {
    blockers.push(`Model catalog has ${unresolvedPolicyCount} unresolved policy reference(s)`);
  }
  if (modelErrors.length > 0 || ambiguousCatalog) {
    blockers.push('Model catalog failed runtime validation or has case-insensitive policy/capability conflicts');
  }
  return {
    supplied: true,
    valid: modelErrors.length === 0 && !ambiguousCatalog && unresolvedPolicyCount === 0,
    entry_count: Object.keys(loadedModels).length,
    unresolved_policy_reference_count: unresolvedPolicyCount,
    fingerprint_sha256: fingerprint(modelCatalog),
  };
}

function tierNodes(tiers, tier) {
  return tiers?.[tier] ?? tiers?.[`tier${tier}`] ?? [];
}

export function planTwoTierCutover({ tiers = {}, credentialIndex = null, policies = null, modelCatalog = null } = {}) {
  const blockers = [];
  const warnings = [];
  const nodeMoves = [];
  const retiredOauth = [];
  const policyReviews = [];
  const seen = new Map();
  const sourceCounts = { tier1: 0, tier2: 0, tier3: 0 };
  const targetCounts = { tier1: 0, tier2: 0 };

  for (const tier of TIERS) {
    if (!Object.hasOwn(tiers, tier) && !Object.hasOwn(tiers, `tier${tier}`)) {
      blockers.push(`tier${tier}: source inventory not supplied; provide [] explicitly when empty`);
    }
  }

  for (const tier of TIERS) {
    const label = `tier${tier}`;
    const nodes = tierNodes(tiers, tier);
    if (!Array.isArray(nodes)) {
      blockers.push(`${label}: expected an array of nodes`);
      continue;
    }
    sourceCounts[label] = nodes.length;
    try {
      const legacyOauthNodes = nodes.filter((node) => plainObject(node) && node.auth === 'oauth');
      // Retired OAuth node metadata is inventoried, never sent through the new
      // static-token node validator. Old Tier 3 static nodes are validated as
      // target Tier 2 to ensure their eventual API Token shape is accepted.
      assertNodesArray(
        nodes.filter((node) => !plainObject(node) || node.auth !== 'oauth'),
        `source-tier-${tier}`,
        tier === 3 ? 2 : tier,
      );
      assertLegacyOauthNodes(legacyOauthNodes, tier);
    } catch {
      // Never print malformed source node values or raw credential material.
      blockers.push(`${label}: invalid source node configuration; run config:check`);
      continue;
    }
    const catalogNames = plainObject(modelCatalog) ? Object.keys(modelCatalog) : [];
    for (const node of nodes) {
      let modelMapping;
      try {
        modelMapping = auditModelMappings(node.models, catalogNames);
      } catch {
        blockers.push(`${label}: node has ambiguous or invalid model mappings; review the source mapping explicitly`);
        continue;
      }
      const nodeId = node.id.trim();
      const previous = seen.get(nodeId);
      if (previous !== undefined) {
        blockers.push(`Duplicate node ID ${nodeId} in tier${previous} and ${label}`);
        continue;
      }
      seen.set(nodeId, tier);
      if (node.auth === 'oauth') {
        retiredOauth.push({
          node_id: nodeId,
          source_tier: tier,
          action: 'retire_subscription_node',
          retired_model_mapping: modelMapping,
        });
        continue;
      }
      const targetTier = tier === 1 ? 1 : 2;
      targetCounts[`tier${targetTier}`] += 1;
      nodeMoves.push({
        node_id: nodeId,
        source_tier: tier,
        target_tier: targetTier,
        action: tier === 1 ? 'retain_free' : tier === 2 ? 'retain_static_token' : 'promote_paid_token',
        source_credential_prefix: `AIG_TIER${tier}_CREDENTIALS_`,
        target_credential_prefix: `AIG_TIER${targetTier}_CREDENTIALS_`,
        model_mapping: modelMapping,
      });
    }
  }

  const classifiedNodeCount = nodeMoves.length + retiredOauth.length;
  const sourceNodeCount = Object.values(sourceCounts).reduce((total, count) => total + count, 0);
  const unclassifiedNodeCount = sourceNodeCount - classifiedNodeCount;
  if (unclassifiedNodeCount > 0) {
    blockers.push(
      `${unclassifiedNodeCount} source node(s) have no safe migration action because their metadata is invalid or conflicts with another node`,
    );
  }

  if (nodeMoves.length === 0) blockers.push('No static-credential nodes are available for the target configuration');

  if (credentialIndex === null) {
    blockers.push('Credential ID index not supplied; source and destination credential ownership cannot be verified');
  } else if (!plainObject(credentialIndex) || Object.keys(credentialIndex).some((key) => !TIERS.some((t) => key === `tier${t}`))) {
    blockers.push('Credential index must be an object with only tier1, tier2 and tier3 ID arrays');
  } else {
    const credentialOwners = new Map();
    for (const tier of TIERS) {
      const key = `tier${tier}`;
      const ids = credentialIndex[key];
      if (!Array.isArray(ids)) {
        blockers.push(`Credential index ${key} must be an array of node IDs`);
        continue;
      }
      for (const id of ids) {
        if (typeof id !== 'string' || !ID.test(id)) {
          blockers.push(`${key}: invalid credential node identifier`);
          continue;
        }
        const previous = credentialOwners.get(id);
        if (previous !== undefined) {
          blockers.push(`Credential node ID ${id} has multiple source assignments`);
          continue;
        }
        credentialOwners.set(id, tier);
      }
    }
    for (const [id, tier] of credentialOwners) {
      const nodeTier = seen.get(id.trim());
      if (nodeTier === undefined) {
        blockers.push(`Credential metadata for ${id} has no matching configured node`);
      } else if (tier !== nodeTier) {
        blockers.push(`Credential tier mismatch for ${id}: index tier${tier}, node tier${nodeTier}`);
      } else if (retiredOauth.some((node) => node.node_id === id)) {
        blockers.push(`OAuth node ${id} unexpectedly has a static credential assignment`);
      }
    }
    for (const move of nodeMoves) {
      if (credentialOwners.get(move.node_id) !== move.source_tier) {
        blockers.push(`Static credential source for ${move.node_id} has not been verified`);
      }
    }
  }

  if (policies === null) blockers.push('Policy inventory not supplied; pass --policies with {} when no custom policies exist');
  let policyDiagnostics = [];
  if (policies !== null) {
    if (!plainObject(policies)) {
      blockers.push('Policies must be an object keyed by policy name');
    } else {
      for (const [name, policy] of Object.entries(policies)) {
        const safe = safePolicyName(name);
        if (!plainObject(policy)) {
          blockers.push(`Policy ${safe} must be an object`);
          continue;
        }
        const attempts = policy.tier_attempts;
        const hedgeTiers = policy.hedge?.tiers;
        if (attempts !== undefined && attempts !== null && !plainObject(attempts)) {
          blockers.push(`Policy ${safe} has malformed tier_attempts`);
        }
        if (hedgeTiers !== undefined && !Array.isArray(hedgeTiers)) {
          blockers.push(`Policy ${safe} has malformed hedge.tiers`);
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
          policyReviews.push({
            policy: safe,
            reasons,
            legacy_tier_attempts: {
              ...(hasOldTwo ? { tier2: Number.isFinite(attempts.tier2) ? attempts.tier2 : null } : {}),
              ...(hasOldThree ? { tier3: Number.isFinite(attempts.tier3) ? attempts.tier3 : null } : {}),
            },
            legacy_hedge_tiers: affectedHedge ? hedgeTiers.filter((value) => value === 'tier2' || value === 'tier3') : [],
            action: 'review_and_rewrite_explicitly',
          });
          blockers.push(`Policy ${safe} requires explicit two-tier budget/hedge review`);
        }
      }
    }
    const policyEnv = { AIG_POLICIES_CONFIG: JSON.stringify(policies) };
    policyDiagnostics = getPoliciesConfigDiagnostics(policyEnv);
    if (policyDiagnostics.length > 0) blockers.push('Policy inventory failed the shared runtime policy validator; run config:check');
  }

  const modelCatalogAudit = auditModelCatalog(modelCatalog, policies, blockers);

  warnings.push('Plan is a read-only preview; no environment variables, Secrets, policies, D1 data or deployments are changed');
  warnings.push('Credential index contains node IDs only; matching credential VALUES or duplicate secret material cannot be verified here');
  warnings.push('Remove old Tier 3 variables only after the new Tier 2 nodes and private-center credential shards are validated');

  return {
    schema_version: 1,
    mode: 'three_to_two_tier_preflight',
    preflight_passed: blockers.length === 0,
    source_counts: sourceCounts,
    unclassified_source_node_count: unclassifiedNodeCount,
    target_counts: targetCounts,
    node_moves: nodeMoves,
    retired_oauth_nodes: retiredOauth,
    policy_reviews: policyReviews,
    model_catalog: modelCatalogAudit,
    policy_inventory: {
      supplied: policies !== null,
      valid: policies !== null && plainObject(policies) && policyDiagnostics.length === 0,
      policy_count: plainObject(policies) ? Object.keys(policies).length : 0,
      fingerprint_sha256: policies !== null ? fingerprint(policies) : null,
    },
    blockers,
    warnings,
  };
}

function argumentsFrom(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !ALLOWED_OPTIONS.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(args, key)) {
      throw new Error('Invalid or repeated option; see the documented --tier1/--tier2/--tier3/--credential-index/--policies/--model-catalog flags');
    }
    args[key] = argv[i + 1];
  }
  if (!TIERS.some((tier) => args[`tier${tier}`])) {
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
    throw new Error(`Unable to read valid JSON from ${label} file`);
  }
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const tiers = Object.fromEntries(TIERS.filter((tier) => args[`tier${tier}`]).map((tier) => [tier, readJson(args[`tier${tier}`], `tier${tier}`)]));
  const credentialIndex = args['credential-index'] ? readJson(args['credential-index'], 'credential-index') : null;
  const policies = args.policies ? readJson(args.policies, 'policies') : null;
  const modelCatalog = args['model-catalog'] ? readJson(args['model-catalog'], 'model catalog') : null;
  const result = planTwoTierCutover({ tiers, credentialIndex, policies, modelCatalog });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.preflight_passed) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Cutover preflight failed: ${error.message}`);
    process.exitCode = 2;
  });
}
