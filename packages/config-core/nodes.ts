import type { Surface } from '../contracts/protocol.ts';
import { getProviderProfile } from '../contracts/provider-profiles.ts';
import type { NodeReasoning, NodeTier, RuntimeNode } from '../contracts/runtime-node.ts';
import type { Tier, TierMap } from '../contracts/scheduler.ts';
import { getBool, readEnv } from './env.ts';
import { getModelsConfigDiagnostics, loadModelsConfig } from './models.ts';
import { getPoliciesConfigDiagnostics, loadPoliciesConfig } from './policies.ts';
import { getProtocolFallbacksDiagnostics } from './protocol-fallbacks.ts';
import type { RegistryEntry } from './registry.ts';
import { canonicalLogicalNames, loadModelRegistry } from './registry.ts';
import { trimTrailingSlashes } from './trim.ts';

export const TIER_SHARD_PATTERN = /^AIG_TIER([12])_NODES_(\d{2})$/;
export const SECRET_SHARD_PATTERN = /^AIG_TIER([12])_CREDENTIALS_(\d{2})$/;
export const MAX_SHARD_INDEX = 10;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FORBIDDEN_NODE_FIELDS = ['token', 'credential', 'api_key', 'apikey', 'authorization', 'password', 'secret'];
const ALLOWED_NODE_FIELDS = new Set(['id', 'provider', 'base_url', 'priority', 'models', 'surfaces', 'key_group', 'reasoning']);

export type ConfigStatus = 'unconfigured' | 'invalid' | 'degraded' | 'ready';

export type GatewayConfig = {
  status: ConfigStatus;
  ready: boolean;
  hasConfigErrors: boolean;
  accessKeyBound: boolean;
  nodes: RuntimeNode[];
  tiers: TierMap<RuntimeNode[]>;
  bindings: {
    tierShards: string[];
    secretShards: string[];
  };
  nodesTotal: number;
  nodesUsable: number;
  diagnostics: string[];
};

let cachedEnv: Record<string, unknown> | undefined;
let cachedResult: GatewayConfig | undefined;
let cachedExecutionEnv: Record<string, unknown> | undefined;
let cachedExecutionResult: GatewayConfig | undefined;

export function loadGatewayConfig(env: Record<string, unknown>): GatewayConfig {
  if (cachedEnv === env && cachedResult) return cachedResult;
  cachedEnv = env;
  cachedResult = buildConfig(env, true);
  return cachedResult;
}

export function loadExecutionConfig(env: Record<string, unknown>): GatewayConfig {
  if (cachedExecutionEnv === env && cachedExecutionResult) return cachedExecutionResult;
  cachedExecutionEnv = env;
  cachedExecutionResult = buildConfig(env, false);
  return cachedExecutionResult;
}

function collectAuxConfigDiagnostics(env: Record<string, unknown>): string[] {
  const diags = [...getModelsConfigDiagnostics(env), ...getPoliciesConfigDiagnostics(env)];
  const models = loadModelsConfig(env);
  const policies = loadPoliciesConfig(env);
  for (const [model, mcfg] of Object.entries(models)) {
    const pname = mcfg?.policy?.policy || 'default';
    if (!policies[pname]) diags.push(`AIG_MODELS_CONFIG: model "${model}" references unknown policy "${pname}"`);
  }
  return diags;
}

function collectNodeModelDiagnostics(nodes: ReadonlyArray<RuntimeNode>, env: Record<string, unknown>): string[] {
  const diags: string[] = [];
  let registry: Record<string, RegistryEntry>;
  try {
    registry = loadModelRegistry(env);
  } catch {
    return diags;
  }
  if (!registry || Object.keys(registry).length === 0) return diags;
  const internalModels = new Set<string>();
  for (const [name, entry] of Object.entries(registry)) {
    if (entry.policy.visibility === 'internal') internalModels.add(name);
  }
  if (internalModels.size === 0) return diags;
  for (const node of nodes) {
    for (const logical of Object.keys(node.models)) {
      if (internalModels.has(logical)) {
        diags.push(
          `NODE CONFIG: node "${node.id}" maps logical model "${logical}" which is marked visibility:"internal" in AIG_MODELS_CONFIG; internal models are still requestable but hidden from the dashboard`,
        );
      }
    }
  }
  return diags;
}

function buildConfig(env: Record<string, unknown>, shouldRequireClientKey: boolean): GatewayConfig {
  const diagnostics: string[] = [];
  const auxDiagnostics = collectAuxConfigDiagnostics(env);
  auxDiagnostics.push(...getProtocolFallbacksDiagnostics(env));
  diagnostics.push(...auxDiagnostics);
  const accessKeyBound = ['AIR', 'PRO', 'MAX', 'ULTRA', 'AGENT'].some((g) => readEnv(env, `AIG_ACCESS_KEY_${g}`));

  const isGatewayInferenceCenterOwned = shouldRequireClientKey;
  const tierShards = collectShards(env, TIER_SHARD_PATTERN, 'AIG_TIER1_NODES_', 'AIG_TIER1_NODES_01', 2, diagnostics);
  const secretShards = collectShards(env, SECRET_SHARD_PATTERN, 'AIG_TIER1_CREDENTIALS_', 'AIG_TIER1_CREDENTIALS_01', 2, diagnostics);

  let hasLegacyTier3Policy = false;
  const rawPolicies = readEnv(env, 'AIG_POLICIES_CONFIG');
  if (rawPolicies) {
    try {
      const parsedPolicies: unknown = JSON.parse(rawPolicies);
      if (parsedPolicies && typeof parsedPolicies === 'object' && !Array.isArray(parsedPolicies)) {
        hasLegacyTier3Policy = Object.values(parsedPolicies).some((policy) => {
          if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return false;
          const p = policy as Record<string, unknown>;
          const attempts = p.tier_attempts;
          const hedge = p.hedge;
          return (
            (attempts !== null && typeof attempts === 'object' && !Array.isArray(attempts) && Object.hasOwn(attempts, 'tier3')) ||
            (hedge !== null &&
              typeof hedge === 'object' &&
              !Array.isArray(hedge) &&
              Array.isArray((hedge as Record<string, unknown>).tiers) &&
              ((hedge as Record<string, unknown>).tiers as unknown[]).includes('tier3'))
          );
        });
      }
    } catch {}
  }
  const legacyTierKeys = Object.keys(env).filter((key) => key.startsWith('AIG_TIER3_'));
  const legacySubscriptionKeys = Object.keys(env).filter(
    (key) => key.startsWith('AIG_OAUTH_') || key === 'AIG_IS_SUBSCRIPTION_ENABLED' || key === 'AIG_TOKEN_ENCRYPTION_KEY',
  );
  if (legacyTierKeys.length > 0 || hasLegacyTier3Policy || legacySubscriptionKeys.length > 0) {
    if (legacyTierKeys.length > 0) {
      diagnostics.push(`two-tier cutover required: legacy Tier 3 variable or credential bindings remain (${legacyTierKeys.sort().join(', ')})`);
    }
    if (hasLegacyTier3Policy) diagnostics.push('two-tier cutover required: deprecated tier3 policy budget or hedge references remain');
    if (legacySubscriptionKeys.length > 0) {
      diagnostics.push(`retired subscription settings are forbidden (${legacySubscriptionKeys.sort().join(', ')})`);
    }
    return {
      status: 'invalid',
      ready: false,
      hasConfigErrors: true,
      accessKeyBound,
      nodes: [],
      tiers: { 1: [], 2: [] },
      bindings: {
        tierShards: tierShards.map((shard) => shard.key).sort(),
        secretShards: secretShards.map((shard) => shard.key).sort(),
      },
      nodesTotal: 0,
      nodesUsable: 0,
      diagnostics,
    };
  }
  const nodesDeclared = tierShards.reduce((sum, s) => sum + countArrayEntries(env[s.key] as string), 0);

  let status: ConfigStatus = 'unconfigured';
  if ((shouldRequireClientKey && !accessKeyBound) || tierShards.length === 0) {
    return {
      status,
      ready: false,
      hasConfigErrors: auxDiagnostics.length > 0,
      accessKeyBound,
      nodes: [],
      tiers: { 1: [], 2: [] },
      bindings: {
        tierShards: tierShards.map((s) => s.key).sort(),
        secretShards: secretShards.map((s) => s.key).sort(),
      },
      nodesTotal: nodesDeclared,
      nodesUsable: 0,
      diagnostics,
    };
  }

  const credentials = new Map<string, string>();
  const credentialTiers = new Map<string, string>();
  const conflictedIds = new Set<string>();
  let hasConfigErrors = auxDiagnostics.length > 0;
  const sortedSecretShards = [...secretShards].sort((a, b) => a.tierNumber - b.tierNumber || a.index - b.index);
  const secretShardsToParse = isGatewayInferenceCenterOwned ? [] : sortedSecretShards;
  for (const shard of secretShardsToParse) {
    const parsed = parseJsonVar(env[shard.key] as string, shard.key, diagnostics, { isSecret: true });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      diagnostics.push(`${shard.key}: must be a JSON object { nodeId: credential }`);
      hasConfigErrors = true;
      continue;
    }
    const shardTier = `tier-${shard.tierNumber}`;
    for (const [nodeId, credential] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof credential !== 'string' || !credential.trim()) {
        diagnostics.push(`${shard.key}: credential for "${nodeId}" is empty`);
        hasConfigErrors = true;
        continue;
      }
      if (credentials.has(nodeId)) {
        diagnostics.push(
          `credential id "${nodeId}" defined in multiple secret shards (${credentialTiers.get(nodeId)} and ${shardTier}); node excluded`,
        );
        conflictedIds.add(nodeId);
        hasConfigErrors = true;
        continue;
      }
      credentials.set(nodeId, credential);
      credentialTiers.set(nodeId, shardTier);
    }
  }

  const isHttpAllowed = getBool(env, 'AIG_CAN_USE_HTTP', false);
  const seenIds = new Map<string, string>();
  let nodes: RuntimeNode[] = [];
  let hasLegacySubscriptionAuth = false;
  const sortedTierShards = [...tierShards].sort((a, b) => a.tierNumber - b.tierNumber || a.index - b.index);
  for (const shard of sortedTierShards) {
    const tier = `tier-${shard.tierNumber}` as NodeTier;
    const parsed = parseJsonVar(env[shard.key] as string, shard.key, diagnostics);
    if (!Array.isArray(parsed)) {
      diagnostics.push(`${shard.key}: must be a JSON array of node objects`);
      hasConfigErrors = true;
      continue;
    }
    for (const rawNode of parsed) {
      if (rawNode && typeof rawNode === 'object' && !Array.isArray(rawNode) && Object.hasOwn(rawNode, 'auth')) {
        diagnostics.push(`${shard.key}: deprecated subscription auth marker; remove the node through the two-tier cutover plan`);
        hasLegacySubscriptionAuth = true;
        hasConfigErrors = true;
        continue;
      }
      const rawId =
        rawNode && typeof rawNode === 'object' && !Array.isArray(rawNode) && typeof (rawNode as Record<string, unknown>).id === 'string'
          ? ((rawNode as Record<string, unknown>).id as string).trim()
          : '';
      const secretTier = ID_PATTERN.test(rawId) ? credentialTiers.get(rawId) : undefined;
      if (secretTier && secretTier !== tier) {
        diagnostics.push(
          `Node "${rawId}" belongs to TIER${shard.tierNumber} but its credential is defined under TIER${secretTier.slice(5)}; node excluded.`,
        );
        hasConfigErrors = true;
        continue;
      }
      const node = buildRuntimeNode(
        rawNode,
        tier,
        credentials,
        isHttpAllowed,
        shard.key,
        diagnostics,
        shouldRequireClientKey,
        isGatewayInferenceCenterOwned,
      );
      if (!node) continue;
      if (seenIds.has(node.id)) {
        diagnostics.push(`duplicate node id "${node.id}" (${seenIds.get(node.id)} and ${shard.key}); node excluded`);
        conflictedIds.add(node.id);
        hasConfigErrors = true;
        continue;
      }
      seenIds.set(node.id, shard.key);
      nodes.push(node);
    }
  }

  if (conflictedIds.size > 0) nodes = nodes.filter((node) => !conflictedIds.has(node.id));
  const canonical = canonicalizeNodeModels(nodes, env, diagnostics);
  if (canonical.isAmbiguous) hasConfigErrors = true;
  nodes = canonical.nodes;
  diagnostics.push(...collectNodeModelDiagnostics(nodes, env));
  for (const [nodeId] of credentials) {
    if (!seenIds.has(nodeId)) diagnostics.push(`credential "${nodeId}" has no matching node config`);
  }

  if (hasLegacySubscriptionAuth) {
    return {
      status: 'invalid',
      ready: false,
      hasConfigErrors: true,
      accessKeyBound,
      nodes: [],
      tiers: { 1: [], 2: [] },
      bindings: {
        tierShards: tierShards.map((shard) => shard.key).sort(),
        secretShards: secretShards.map((shard) => shard.key).sort(),
      },
      nodesTotal: nodesDeclared,
      nodesUsable: 0,
      diagnostics,
    };
  }
  if (nodes.length === 0) status = 'invalid';
  else if (hasConfigErrors || nodes.length < nodesDeclared) status = 'degraded';
  else status = 'ready';
  const ready = status === 'ready' || status === 'degraded';

  const tiers: TierMap<RuntimeNode[]> = { 1: [], 2: [] };
  for (const node of nodes) {
    const tierNumber: Tier = node.tier === 'tier-1' ? 1 : 2;
    tiers[tierNumber].push(node);
  }
  for (const list of Object.values(tiers)) list.sort((a, b) => a.priority - b.priority);

  return {
    status,
    ready,
    hasConfigErrors,
    accessKeyBound,
    nodes,
    tiers,
    bindings: {
      tierShards: sortedTierShards.map((s) => s.key),
      secretShards: sortedSecretShards.map((s) => s.key),
    },
    nodesTotal: nodesDeclared,
    nodesUsable: nodes.length,
    diagnostics,
  };
}

function buildRuntimeNode(
  rawNode: unknown,
  tier: NodeTier,
  credentials: Map<string, string>,
  isHttpAllowed: boolean,
  sourceKey: string,
  diagnostics: string[],
  isGateway: boolean,
  isGatewayInferenceCenterOwned: boolean,
): RuntimeNode | null {
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
    diagnostics.push(`${sourceKey}: entry is not a JSON object`);
    return null;
  }
  const rec = rawNode as Record<string, unknown>;
  const id = typeof rec.id === 'string' ? rec.id.trim() : '';
  if (!ID_PATTERN.test(id)) {
    diagnostics.push(`${sourceKey}: node id "${String(rec.id).slice(0, 40)}" is missing or invalid (lowercase letters, digits, hyphens)`);
    return null;
  }
  if ('tier' in rec) {
    diagnostics.push(`node "${id}": "tier" field is not allowed; the tier comes from the variable name (${sourceKey})`);
    return null;
  }
  const forbidden = FORBIDDEN_NODE_FIELDS.filter((f) => f in rec);
  if (forbidden.length > 0) {
    diagnostics.push(`node "${id}": forbidden credential field(s) ${forbidden.join(', ')}; credentials belong in AIG_TIER{N}_CREDENTIALS_*`);
    return null;
  }
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_NODE_FIELDS.has(key)) {
      diagnostics.push(`node "${id}": unknown field "${key}" (allowed: id, provider, base_url, priority, models, surfaces, key_group, reasoning)`);
      return null;
    }
  }

  const keyGroup = rec.key_group === undefined ? undefined : typeof rec.key_group === 'string' ? rec.key_group.trim() : null;
  if (keyGroup === null || (keyGroup !== undefined && !ID_PATTERN.test(keyGroup))) {
    diagnostics.push(`node "${id}": key_group must be a lowercase non-secret identifier (1-64 characters)`);
    return null;
  }

  const provider = typeof rec.provider === 'string' ? rec.provider.trim().toLowerCase() : '';
  if (!provider) {
    diagnostics.push(`node "${id}": provider is required and must be a non-empty string`);
    return null;
  }

  const profile = getProviderProfile(provider);
  const isImageOnly = profile.wire.surfaces.length === 1 && profile.wire.surfaces[0] === 'images_generations';
  const credentialBelongsToCenter = isGateway && (isGatewayInferenceCenterOwned || isImageOnly);

  const rawBaseUrl = typeof rec.base_url === 'string' ? rec.base_url.trim() : '';
  const baseUrl = rawBaseUrl;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    diagnostics.push(`node "${id}": base_url is missing or not a valid URL`);
    return null;
  }
  if (!isHttpAllowed && url.protocol !== 'https:') {
    diagnostics.push(`node "${id}": base_url must use https:// (set AIG_CAN_USE_HTTP=true to override)`);
    return null;
  }
  if (url.username || url.password) {
    diagnostics.push(`node "${id}": base_url must not contain username/password`);
    return null;
  }

  const credential = credentials.get(id) || '';
  if (!credential && !credentialBelongsToCenter) {
    diagnostics.push(`node "${id}": no credential found in AIG_TIER{N}_CREDENTIALS_*; node excluded`);
    return null;
  }

  const models = normalizeModels(rec.models, id, diagnostics);
  if (models === null) return null;
  const priority = parsePriority(rec.priority, id, diagnostics);
  if (priority === null) return null;
  const { protocol, surfaces: defaultSurfaces } = profile.wire;
  const surfaces = resolveConfiguredSurfaces(rec.surfaces, defaultSurfaces, protocol, isImageOnly, id, diagnostics);
  if (!surfaces) return null;

  const reasoning = parseNodeReasoning(rec.reasoning, id, protocol, diagnostics);
  if (reasoning === null) return null;

  return {
    id,
    ...(keyGroup ? { keyGroup } : {}),
    tier,
    provider,
    protocol,
    surfaces,
    baseUrl: trimTrailingSlashes(baseUrl),
    credential: credentialBelongsToCenter ? '' : credential,
    priority,
    models,
    ...(reasoning ? { reasoning } : {}),
  };
}

function parseNodeReasoning(
  value: unknown,
  nodeId: string,
  protocol: 'openai' | 'anthropic',
  diagnostics: string[],
): NodeReasoning | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(`node "${nodeId}": reasoning must be an object`);
    return null;
  }
  const config = value as Record<string, unknown>;
  const mode = config.mode;
  if (!['none', 'effort', 'adaptive', 'budget'].includes(String(mode))) {
    diagnostics.push(`node "${nodeId}": reasoning.mode must be none, effort, adaptive or budget`);
    return null;
  }
  if ((mode === 'adaptive' || mode === 'budget') && protocol !== 'anthropic') {
    diagnostics.push(`node "${nodeId}": adaptive/budget reasoning requires Anthropic protocol`);
    return null;
  }
  if (Object.keys(config).some((key) => !['mode', 'efforts', 'high_budget_tokens'].includes(key))) {
    diagnostics.push(`node "${nodeId}": unknown reasoning configuration field`);
    return null;
  }
  const efforts = config.efforts;
  if (
    efforts !== undefined &&
    (!Array.isArray(efforts) || efforts.length === 0 || efforts.some((e) => !['low', 'medium', 'high', 'max'].includes(String(e))))
  ) {
    diagnostics.push(`node "${nodeId}": reasoning.efforts must contain recognized effort levels`);
    return null;
  }
  if (mode === 'effort' && (!Array.isArray(efforts) || efforts.length === 0)) {
    diagnostics.push(`node "${nodeId}": effort reasoning requires declared efforts`);
    return null;
  }
  const highBudgetTokens = config.high_budget_tokens;
  if (mode === 'budget' && (!Number.isSafeInteger(highBudgetTokens) || Number(highBudgetTokens) < 1024 || Number(highBudgetTokens) > 32768)) {
    diagnostics.push(`node "${nodeId}": budget reasoning requires high_budget_tokens between 1024 and 32768`);
    return null;
  }
  if (mode !== 'budget' && highBudgetTokens !== undefined) {
    diagnostics.push(`node "${nodeId}": high_budget_tokens is only supported for budget reasoning`);
    return null;
  }
  return {
    mode: mode as NodeReasoning['mode'],
    ...(Array.isArray(efforts) ? { efforts: [...new Set(efforts)] as NonNullable<NodeReasoning['efforts']> } : {}),
    ...(mode === 'budget' ? { highBudgetTokens: highBudgetTokens as number } : {}),
  };
}

function resolveConfiguredSurfaces(
  raw: unknown,
  defaults: ReadonlyArray<Surface>,
  protocol: 'openai' | 'anthropic',
  isImageOnly: boolean,
  nodeId: string,
  diagnostics: string[],
): ReadonlyArray<Surface> | null {
  if (raw === undefined) return defaults;
  const allowed: ReadonlyArray<Surface> = protocol === 'openai' && !isImageOnly ? ['chat_completions', 'responses'] : defaults;
  const supported = new Set<string>(allowed);
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== 'string' || !supported.has(item))) {
    diagnostics.push(`node "${nodeId}": surfaces must be a non-empty list of supported wire endpoints (${allowed.join(', ')})`);
    return null;
  }
  if (new Set(raw).size !== raw.length) {
    diagnostics.push(`node "${nodeId}": surfaces must not contain duplicates`);
    return null;
  }
  return raw as Surface[];
}

function parsePriority(raw: unknown, nodeId: string, diagnostics: string[]): number | null {
  if (raw === undefined) return 100;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    diagnostics.push(`node "${nodeId}": priority must be a non-negative integer number`);
    return null;
  }
  return raw;
}

function canonicalizeNodeModels(
  nodes: RuntimeNode[],
  env: Record<string, unknown>,
  diagnostics: string[],
): { nodes: RuntimeNode[]; isAmbiguous: boolean } {
  let configured: string[] = [];
  try {
    configured = Object.keys(loadModelsConfig(env));
  } catch {}
  const canonical = canonicalLogicalNames(
    nodes.flatMap((node) => Object.keys(node.models)),
    configured,
  );
  let isAmbiguous = false;
  const kept: RuntimeNode[] = [];
  for (const node of nodes) {
    const models: Record<string, string> = {};
    let isConflict = false;
    for (const [name, upstream] of Object.entries(node.models)) {
      const logical = canonical.get(name.trim().toLowerCase()) ?? name;
      if (models[logical] !== undefined && models[logical] !== upstream) {
        diagnostics.push(
          `node "${node.id}": logical model "${logical}" maps to two different upstream models under different casings; node excluded`,
        );
        isConflict = true;
        break;
      }
      models[logical] = upstream;
    }
    if (isConflict) {
      isAmbiguous = true;
      continue;
    }
    kept.push({ ...node, models });
  }
  return { nodes: kept, isAmbiguous };
}

function normalizeModels(models: unknown, nodeId: string, diagnostics: string[]): Record<string, string> | null {
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    diagnostics.push(
      `node "${nodeId}": models is required and must be an object { logical: upstream }; use {} only for an intentional catalog-bounded wildcard`,
    );
    return null;
  }

  const out: Record<string, string> = {};
  for (const key of Object.keys(models)) {
    if (!key.trim()) {
      diagnostics.push(`node "${nodeId}": models keys must be non-empty strings`);
      return null;
    }
    const value = (models as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !value.trim()) {
      diagnostics.push(`node "${nodeId}": models["${key}"] must map to a non-empty upstream model string`);
      return null;
    }
    out[key.trim()] = value.trim();
  }
  return out;
}

export function collectShards(
  env: Record<string, unknown>,
  pattern: RegExp,
  loosePrefix: string,
  expectedExample: string,
  indexGroup: number,
  diagnostics: string[],
): Array<{ key: string; index: number; tierNumber: number }> {
  const shards: Array<{ key: string; index: number; tierNumber: number }> = [];
  for (const key of Object.keys(env || {})) {
    const match = pattern.exec(key);
    if (match) {
      const index = Number(match[indexGroup]);
      if (index < 1 || index > MAX_SHARD_INDEX) {
        diagnostics.push(`${key}: shard index out of range (expected 01..${String(MAX_SHARD_INDEX).padStart(2, '0')}); ignored`);
        continue;
      }
      shards.push({
        key,
        tierNumber: pattern.source.includes('TIER') ? Number(match[1]) : 0,
        index,
      });
      continue;
    }
    if (!pattern.test(key) && key.startsWith(loosePrefix)) {
      diagnostics.push(`${key}: malformed shard name (expected ${expectedExample}); ignored`);
    }
  }
  return shards;
}

function parseJsonVar(raw: string, key: string, diagnostics: string[], { isSecret = false }: { isSecret?: boolean } = {}): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagnostics.push(isSecret ? `${key}: invalid JSON` : `${key}: invalid JSON (${msg})`);
    return null;
  }
}

function countArrayEntries(raw: string): number {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
