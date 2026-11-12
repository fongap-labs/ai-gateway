#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Enforce dependency direction incrementally: packages are neutral; apps may
// depend on packages; cross-app source imports are always forbidden.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
function walk(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((name) => {
    const target = join(folder, name);
    return statSync(target).isDirectory() ? walk(target) : target.endsWith('.ts') ? [target] : [];
  });
}
const biomeConfig = readFileSync(join(root, 'biome.jsonc'), 'utf8');
for (const glob of ['apps/**/*.ts', 'packages/**/*.ts', 'operations/**/*.ts']) {
  assert.ok(biomeConfig.includes(`"${glob}"`), `Biome must check every extracted runtime module: ${glob}`);
}

let checked = 0;
for (const file of [...walk(join(root, 'packages')), ...walk(join(root, 'apps')), ...walk(join(root, 'operations'))]) {
  const local = relative(root, file).replaceAll('\\', '/');
  const imports = [...readFileSync(file, 'utf8').matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)];
  for (const [, specifier] of imports) {
    if (!specifier?.startsWith('.')) continue;
    const target = relative(root, resolve(file, '..', specifier)).replaceAll('\\', '/');
    if (local.startsWith('packages/')) {
      assert.ok(!target.startsWith('src/') && !target.startsWith('apps/'), `${local} imports implementation: ${target}`);
    }
    if (local.startsWith('apps/')) {
      const ownApp = local.split('/')[1];
      // Perception currently reuses Inference's single physical executor. This
      // narrowly audited edge is temporary: it cannot expand to other modules,
      // scheduling, response codecs, or another application's implementation.
      const isApprovedPerceptionExecutionReuse =
        local === 'apps/perception/index.ts' && target === 'apps/inference/execution.ts';
      assert.ok(
        !target.startsWith('apps/') || target.startsWith(`apps/${ownApp}/`) || isApprovedPerceptionExecutionReuse,
        `${local} imports another app: ${target}`,
      );
    }
    if (local.startsWith('apps/') || local.startsWith('operations/')) {
      assert.ok(
        target !== 'src/types/runtime.ts' && target !== 'src/types/cloudflare.ts',
        `${local} must import the shared runtime type contract directly: ${target}`,
      );
    }
    if (local.startsWith('operations/')) {
      assert.ok(!target.startsWith('apps/') && !target.startsWith('src/'), `${local} must depend on owned or neutral modules: ${target}`);
    }
  }
  checked++;
}
assert.ok(checked >= 4, 'Missing independently owned app entrypoints or contracts');
// Runtime and D1 binding types are cross-application contracts, not a
// dependency on the former monolithic Gateway runtime directory.
for (const [legacy, owner, exports] of [
  ['src/types/cloudflare.ts', '../../packages/contracts/cloudflare.ts', ['D1Database', 'D1PreparedStatement', 'D1Result']],
  ['src/types/runtime.ts', '../../packages/contracts/runtime.ts', ['ExecutionContextLike', 'GatewayEnv', 'GatewayLogger']],
]) {
  const compat = readFileSync(join(root, legacy), 'utf8');
  assert.ok(compat.includes(`from '${owner}'`), `${legacy} must only re-export neutral shared types`);
  assert.doesNotMatch(compat, /^import /m, `${legacy} must not import an implementation`);
  assert.doesNotMatch(compat, /^export type \w+(?:<.*>)?\s*=/m, `${legacy} must not define runtime types`);
  for (const typeName of exports) {
    assert.match(readFileSync(join(root, 'packages/contracts', owner.split('/').at(-1)), 'utf8'), new RegExp(`export type ${typeName}\\b`));
  }
}
for (const entry of ['apps/gateway/index.ts', 'apps/inference/index.ts', 'apps/generation/index.ts', 'operations/index.ts']) {
  const source = readFileSync(join(root, entry), 'utf8');
  assert.ok(source.includes('packages/contracts/runtime.ts'), `${entry} must depend on the shared runtime type contract`);
}

// One neutral image request validator is shared by Gateway admission and the
// private Generation Center. Legacy paths are only compatibility exports.
const legacyImageRequestContract = readFileSync(join(root, 'src/protocol/image.ts'), 'utf8');
const sharedImageRequestContract = readFileSync(join(root, 'packages/contracts/image-request.ts'), 'utf8');
assert.ok(
  legacyImageRequestContract.includes("export * from '../../packages/contracts/image-request.ts';"),
  'Legacy image request contract must only re-export neutral owner',
);
assert.doesNotMatch(legacyImageRequestContract, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
assert.match(sharedImageRequestContract, /export function validateImageGenerationRequest\(/);
assert.ok(sharedImageRequestContract.includes("from './image-capabilities.ts'"), 'Image size must reuse shared capability type');
for (const entry of ['apps/gateway/preflight.ts', 'apps/generation/execution.ts']) {
  const caller = readFileSync(join(root, entry), 'utf8');
  assert.ok(caller.includes("from '../../packages/contracts/image-request.ts'"), `${entry} must use the shared image input contract`);
  assert.doesNotMatch(caller, /from ['"]\.\.\/\.\.\/src\/protocol\/image\.ts['"]/);
}
for (const rule of ['ALLOWED', 'prompt.length > 2048', 'value.n !== 1', "value.response_format !== 'b64_json'"]) {
  assert.ok(sharedImageRequestContract.includes(rule), `Image request validation must preserve ${rule}`);
}

// Only the public Gateway may consume and validate quota hints from private
// execution centers. No copy of the parsing rule may remain in legacy src.
const privateCenterQuotaShim = readFileSync(join(root, 'src/reliability/center-quota.ts'), 'utf8');
const gatewayCenterQuotaOwner = readFileSync(join(root, 'apps/gateway/reliability/center-quota.ts'), 'utf8');
assert.ok(
  privateCenterQuotaShim.includes("export * from '../../apps/gateway/reliability/center-quota.ts';"),
  'Legacy center quota path must re-export Gateway owner',
);
assert.doesNotMatch(privateCenterQuotaShim, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
assert.match(gatewayCenterQuotaOwner, /export function quotaFromCenter\(/);
assert.match(gatewayCenterQuotaOwner, /encoded.length > 512/, 'Center quota must reject oversized hints');
assert.match(gatewayCenterQuotaOwner, /Number.isSafeInteger/, 'Center quota must reject noninteger reports');
assert.match(gatewayCenterQuotaOwner, /source: 'private-center'/, 'Center quota must only trust private signals');
for (const name of ['inference-dispatch.ts', 'generation-dispatch.ts']) {
  const path = `apps/gateway/attempt/${name}`;
  const consumer = readFileSync(join(root, path), 'utf8');
  assert.ok(consumer.includes("from '../reliability/center-quota.ts'"), `${path} must call Gateway-owned quota parser`);
  assert.doesNotMatch(consumer, /from ['"]\.\.\/\.\.\/reliability\/center-quota\.ts['"]/);
}

// Gateway owns the isolate-local speculative retry budget. Legacy imports
// must share the one live slot counter instead of duplicating mutable state.
const retryBudgetLegacy = readFileSync(join(root, 'src/reliability/retry-budget.ts'), 'utf8');
const retryBudgetOwner = readFileSync(join(root, 'apps/gateway/reliability/retry-budget.ts'), 'utf8');
const retryBudgetRequest = readFileSync(join(root, 'apps/gateway/request-handler.ts'), 'utf8');
const retryBudgetLoop = readFileSync(join(root, 'apps/gateway/tier-loop.ts'), 'utf8');
assert.ok(
  retryBudgetLegacy.includes("export * from '../../apps/gateway/reliability/retry-budget.ts';"),
  'Legacy retry budget must forward to the one Gateway owner',
);
assert.doesNotMatch(retryBudgetLegacy, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
assert.match(retryBudgetOwner, /export class RetrySlot/, 'Gateway must own speculative retry slots');
assert.match(retryBudgetOwner, /export function isSpeculativeRetryAfter\(/);
assert.match(retryBudgetOwner, /export function snapshotRetryBudget\(/);
assert.match(retryBudgetOwner, /RETRY_BUDGET_MIN = 3/, 'Gateway minimum admission contract must remain stable');
assert.ok(retryBudgetRequest.includes("from './reliability/retry-budget.ts'"), 'Gateway request admission must directly share the retry owner');
assert.ok(retryBudgetLoop.includes("from './reliability/retry-budget.ts'"), 'Gateway tier policy must directly share the retry owner');
for (const caller of [retryBudgetRequest, retryBudgetLoop]) {
  assert.doesNotMatch(caller, /from ['"]\.\.\/\.\.\/src\/reliability\/retry-budget\.ts['"]/);
}

// Provider quota observations and protocol/surface vocabulary are shared
// runtime-neutral contracts consumed directly by the private centers.
const legacyProtocolTypes = readFileSync(join(root, 'src/types/protocol.ts'), 'utf8');
const sharedProtocolTypes = readFileSync(join(root, 'packages/contracts/protocol.ts'), 'utf8');
const legacyQuotaSignal = readFileSync(join(root, 'src/reliability/quota-signal.ts'), 'utf8');
const sharedQuotaSignal = readFileSync(join(root, 'packages/contracts/quota-signal.ts'), 'utf8');
assert.ok(legacyProtocolTypes.includes("export type { Protocol, Surface } from '../../packages/contracts/protocol.ts';"));
assert.ok(legacyQuotaSignal.includes("export * from '../../packages/contracts/quota-signal.ts';"));
assert.doesNotMatch(legacyProtocolTypes, /^(?:import|export type (?:Protocol|Surface)\s*=) /m);
assert.doesNotMatch(legacyQuotaSignal, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
assert.match(sharedProtocolTypes, /export type Protocol = 'openai' \| 'anthropic'/);
assert.match(sharedProtocolTypes, /export type Surface = import\('\.\/execution\.ts'\)\.ExecutionSurface/);
assert.match(sharedQuotaSignal, /export function extractQuotaSignal\(/);
assert.ok(sharedQuotaSignal.includes("from './protocol.ts'"));
for (const center of ['apps/inference/execution.ts', 'apps/generation/execution.ts']) {
  const source = readFileSync(join(root, center), 'utf8');
  assert.ok(source.includes("from '../../packages/contracts/quota-signal.ts'"), `${center} must use shared quota parser`);
  assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/src\/reliability\/quota-signal\.ts['"]/);
}
const gatewayCenterQuota = readFileSync(join(root, 'apps/gateway/reliability/center-quota.ts'), 'utf8');
assert.ok(gatewayCenterQuota.includes("from '../../../packages/contracts/quota-signal.ts'"), 'Gateway quota decoder must share neutral quota type');
for (const required of ['OPENAI_REMAINING_REQUESTS', 'ANTHROPIC_REMAINING_REQUESTS', 'parseCompoundDurationMs', 'parseResetToMs']) {
  assert.ok(sharedQuotaSignal.includes(required), `Quota parsing must retain ${required}`);
}

// OpenAI/Anthropic native wire contracts are shared transport primitives;
// legacy provider transport files must not duplicate executable semantics.
for (const [legacy, owner, symbols] of [
  ['src/transport/openai.ts', 'packages/transport/openai-native.ts', ['buildOpenAIHeaders', 'resolveOpenAIPath', 'isOpenAIChatRealOutput']],
  [
    'src/transport/anthropic.ts',
    'packages/transport/anthropic-native.ts',
    ['buildAnthropicHeaders', 'resolveAnthropicPath', 'isAnthropicNativeRealOutput'],
  ],
]) {
  const shim = readFileSync(join(root, legacy), 'utf8');
  const code = readFileSync(join(root, owner), 'utf8');
  const relativeOwner = owner.replace(/^packages\//, '../../packages/');
  assert.ok(shim.includes(`export * from '${relativeOwner}';`), `${legacy} must only re-export neutral wire owner`);
  assert.doesNotMatch(shim, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
  assert.ok(code.includes("from '../contracts/protocol.ts'"), `${owner} must consume shared protocol types`);
  assert.doesNotMatch(code, /from ['"][^'"]*\/src\//);
  for (const symbol of symbols) {
    assert.ok(code.includes(`function ${symbol}(`), `${owner} must implement ${symbol}`);
  }
}
const legacyTransportFacade = readFileSync(join(root, 'src/transport/index.ts'), 'utf8');
assert.ok(legacyTransportFacade.includes("from '../../packages/transport/openai-native.ts'"));
assert.ok(legacyTransportFacade.includes("from '../../packages/transport/anthropic-native.ts'"));
assert.doesNotMatch(legacyTransportFacade, /from ['"]\.\/(?:openai|anthropic)\.ts['"]/);

// Public request policy and cache implementations are Gateway-owned. The
// former src/request modules may only re-export their owned implementations.
for (const [legacy, owner, exportedSymbol] of [
  ['src/request/auth.ts', 'apps/gateway/policy/auth.ts', 'authorize'],
  ['src/request/router.ts', 'apps/gateway/policy/router.ts', 'detectRoute'],
  ['src/request/model-authz.ts', 'apps/gateway/policy/model-authz.ts', 'authorizeModel'],
  ['src/request/route-feasibility.ts', 'apps/gateway/policy/route-feasibility.ts', 'evaluateRouteFeasibility'],
  ['src/request/edge-cache.ts', 'apps/gateway/cache/edge-cache.ts', 'matchEdgeCache'],
]) {
  const compatibility = readFileSync(join(root, legacy), 'utf8');
  const owned = readFileSync(join(root, owner), 'utf8');
  const fromParts = legacy.split('/').slice(0, -1);
  const targetParts = owner.split('/');
  while (fromParts.length && targetParts.length && fromParts[0] === targetParts[0]) {
    fromParts.shift();
    targetParts.shift();
  }
  const specifier = [...fromParts.map(() => '..'), ...targetParts].join('/');
  assert.ok(compatibility.includes(`export * from '${specifier}';`), `${legacy} must re-export its unique Gateway owner`);
  assert.doesNotMatch(compatibility, /^import |^export (?:async )?(?:function|const|class) /m, `${legacy} must contain no implementation`);
  assert.ok(
    owned.includes(`function ${exportedSymbol}(`) || owned.includes(`async function ${exportedSymbol}(`),
    `${owner} must implement ${exportedSymbol}`,
  );
}
for (const [entry, expectedImports] of [
  ['apps/gateway/index.ts', ['./policy/router.ts']],
  ['apps/gateway/preflight.ts', ['./policy/auth.ts', './policy/model-authz.ts', './policy/route-feasibility.ts', './policy/router.ts']],
  ['apps/gateway/request-handler.ts', ['./cache/edge-cache.ts', './policy/route-feasibility.ts', './policy/router.ts']],
  ['apps/gateway/tier-loop.ts', ['./policy/router.ts']],
  ['apps/gateway/cache/edge-cache.ts', ['../policy/auth.ts']],
  ['apps/gateway/policy/route-feasibility.ts', ['./router.ts']],
]) {
  const source = readFileSync(join(root, entry), 'utf8');
  for (const specifier of expectedImports) {
    assert.ok(source.includes(`from '${specifier}'`), `${entry} must directly use Gateway policy/cache: ${specifier}`);
  }
  assert.doesNotMatch(
    source,
    /from ['"][^'"]*\/src\/request\/(auth|router|model-authz|route-feasibility|edge-cache)\.ts['"]/,
    `${entry} must not depend on a legacy request policy/cache implementation`,
  );
}

// Logical-model fallback and per-tier retry admission are Gateway policy,
// not independent execution center schedulers. Legacy sources only re-export.
for (const [legacy, owner, symbol] of [
  ['src/request/model-fallback.ts', 'apps/gateway/policy/model-fallback.ts', 'buildModelFallbackPlan'],
  ['src/request/tier-loop.ts', 'apps/gateway/scheduling/tier-policy.ts', 'computeTierCaps'],
]) {
  const legacyCode = readFileSync(join(root, legacy), 'utf8');
  const ownerCode = readFileSync(join(root, owner), 'utf8');
  const expected =
    legacy === 'src/request/model-fallback.ts' ? '../../apps/gateway/policy/model-fallback.ts' : '../../apps/gateway/scheduling/tier-policy.ts';
  assert.ok(legacyCode.includes(`export * from '${expected}';`), `${legacy} must be a compatibility-only export`);
  assert.doesNotMatch(legacyCode, /export (?:async )?function /, `${legacy} must not keep a competing scheduler implementation`);
  assert.ok(ownerCode.includes(`function ${symbol}(`), `${owner} must own ${symbol}`);
}
for (const [entry, specifier] of [
  ['apps/gateway/preflight.ts', './policy/model-fallback.ts'],
  ['apps/gateway/request-handler.ts', './policy/model-fallback.ts'],
  ['apps/gateway/request-handler.ts', './scheduling/tier-policy.ts'],
  ['apps/gateway/fallback.ts', './scheduling/tier-policy.ts'],
  ['apps/gateway/tier-loop.ts', './scheduling/tier-policy.ts'],
]) {
  const source = readFileSync(join(root, entry), 'utf8');
  assert.ok(source.includes(`from '${specifier}'`), `${entry} must use Gateway-owned model/tier policy`);
  assert.doesNotMatch(
    source,
    /from ['"][^'"]*\/src\/request\/(model-fallback|tier-loop)\.ts['"]/,
    `${entry} cannot use the old scheduling implementations`,
  );
}
const tierOwnerSource = readFileSync(join(root, 'apps/gateway/scheduling/tier-policy.ts'), 'utf8');
assert.match(tierOwnerSource, /return applyConsumed\(\)/, 'Tier policy must preserve shared request-wide attempt accounting');
assert.match(tierOwnerSource, /policy\.tierAttempts/, 'Explicit per-tier attempt caps must stay binding');

// Legacy subscription Tier 2 must be removed, not redirected through a
// compatibility shim or a dormant feature flag. Historical D1 migrations
// remain immutable, but no executable OAuth / subscriber owner is permitted.
for (const obsolete of [
  'apps/gateway/oauth/routes.ts',
  'apps/inference/credentials/resolve.ts',
  'src/oauth/crypto.ts',
  'src/oauth/provider-configs.ts',
  'src/oauth/resolve.ts',
  'src/oauth/routes.ts',
  'src/oauth/token-store.ts',
  'src/subscription/index.ts',
  'src/subscription/types.ts',
  'src/subscription/anthropic.ts',
  'src/subscription/google.ts',
  'src/subscription/google-wire.ts',
  'src/subscription/openai.ts',
  'src/subscription/quota-hints.ts',
  'packages/oauth/crypto.ts',
  'packages/oauth/token-store.ts',
]) {
  assert.ok(!existsSync(join(root, obsolete)), `Legacy subscription code must be deleted: ${obsolete}`);
}
for (const owned of [
  'apps/gateway/preflight.ts',
  'apps/gateway/attempt/inference-dispatch.ts',
  'apps/inference/execution.ts',
  'src/providers/registry.ts',
  'src/providers/types.ts',
  'src/types/node.ts',
  'src/config/runtime-vars.ts',
]) {
  const source = readFileSync(join(root, owned), 'utf8');
  assert.doesNotMatch(
    source,
    /(?:from\s+['"][^'"]*(?:\/oauth\/|\/subscription\/)|handleOAuthRoute|resolveSubscriptionCredential|SubscriptionAdapter|subscriptionEndpoint|AIG_IS_SUBSCRIPTION_ENABLED)/,
    `${owned} must not retain subscription routing, adapters, credentials or flags`,
  );
}
for (const subtree of ['src', 'apps', 'packages']) {
  for (const filename of walk(join(root, subtree))) {
    const owner = relative(root, filename);
    const source = readFileSync(filename, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:\/oauth\/|\/subscription\/)/, `Retired subscriber module import remains in ${owner}`);
  }
}
const gatewayPreflight = readFileSync(join(root, 'apps/gateway/preflight.ts'), 'utf8');
assert.ok(gatewayPreflight.includes("pathname.startsWith('/oauth/')"), 'Retired OAuth routes must fail closed, not fall through');
assert.doesNotMatch(
  readFileSync(join(root, 'src/types/node.ts'), 'utf8'),
  /auth\?: 'oauth'/,
  'New Tier 2 nodes must be static Token credentials only',
);

// Gateway protocol fallback is an orchestration-only control surface.
// It must use the private Inference Center's bounded preflight and never
// import the private request converter or execute a local translator.
const gatewayFallback = readFileSync(join(root, 'apps/gateway/fallback.ts'), 'utf8');
assert.ok(gatewayFallback.includes("from './transport/inference-preflight-client.ts'"));
assert.ok(gatewayFallback.includes("from '../../packages/conversion-core/protocol-pairs.ts'"));
assert.match(gatewayFallback, /await checkInferenceConversion\(/);
assert.doesNotMatch(gatewayFallback, /\bconvertMatrixRequest\s*\(/);
assert.doesNotMatch(gatewayFallback, /from ['"][^'"]*\/conversion\/matrix\/pipeline\.ts['"]/);
const pairContract = readFileSync(join(root, 'packages/conversion-core/protocol-pairs.ts'), 'utf8');
assert.doesNotMatch(pairContract, /from ['"][^'"]*(?:apps\/|src\/|providers\/)/);
assert.match(pairContract, /export function isMatrixPair\(/);

// Gateway-owned streaming and image success handlers are the only
// implementations; old request/attempt modules are compatibility-only.
for (const [legacy, owner, symbol] of [
  ['src/request/attempt/success-image.ts', 'apps/gateway/attempt/success-image.ts', 'handleImageSuccess'],
  ['src/request/attempt/success-stream.ts', 'apps/gateway/attempt/success-stream.ts', 'handleStreamingSuccess'],
]) {
  const shim = readFileSync(join(root, legacy), 'utf8');
  const impl = readFileSync(join(root, owner), 'utf8');
  assert.ok(shim.includes(`export * from '../../../${owner}';`), `${legacy} must re-export the unique Gateway owner`);
  assert.doesNotMatch(shim, /^(?:import|export (?:async )?(?:function|const|class)) /m, `${legacy} must not retain execution code`);
  assert.ok(impl.includes(`export async function ${symbol}(`), `${owner} must implement ${symbol}`);
  assert.ok(impl.includes("from '../response/errors.ts'"), `${owner} must use Gateway error handling`);
  assert.ok(impl.includes("from '../response/response-helpers.ts'"), `${owner} must use Gateway response helpers`);
}
const successDispatcher = readFileSync(join(root, 'apps/gateway/attempt/success.ts'), 'utf8');
const legacySuccessDispatcher = readFileSync(join(root, 'src/request/attempt/success.ts'), 'utf8');
assert.ok(legacySuccessDispatcher.includes("export * from '../../../apps/gateway/attempt/success.ts';"), 'Old success dispatcher must only forward');
assert.doesNotMatch(legacySuccessDispatcher, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
assert.match(successDispatcher, /export async function handleSuccess\(/, 'Gateway must own the success dispatcher');
assert.ok(successDispatcher.includes("from './success-image.ts'"), 'Image handler must be Gateway-owned');
assert.ok(successDispatcher.includes("from './success-stream.ts'"), 'Native stream finalizer must be Gateway-owned');

// Matrix reply handling belongs to Gateway; the original request module
// only forwards its exports. Keep real transport, account, and finalization
// assertions attached to the owned file rather than its compatibility shim.
const legacyMatrixSuccess = readFileSync(join(root, 'src/request/attempt/success-matrix.ts'), 'utf8');
const ownedMatrixSuccess = readFileSync(join(root, 'apps/gateway/attempt/success-matrix.ts'), 'utf8');
assert.ok(
  legacyMatrixSuccess.includes("export * from '../../../apps/gateway/attempt/success-matrix.ts';"),
  'Old matrix response path must forward to its unique Gateway owner',
);
assert.doesNotMatch(legacyMatrixSuccess, /^(?:import|export (?:async )?(?:function|const|class)) /m);
assert.match(ownedMatrixSuccess, /export function isMatrixConversion\(/);
assert.match(ownedMatrixSuccess, /export async function handleMatrixSuccess\(/);
assert.match(ownedMatrixSuccess, /from '\.\/oversize\.ts'/);
assert.match(ownedMatrixSuccess, /from '\.\.\/response\/errors\.ts'/);
assert.match(ownedMatrixSuccess, /from '\.\.\/response\/response-helpers\.ts'/);
assert.match(ownedMatrixSuccess, /from '\.\.\/transport\/inference-stream-client\.ts'/);
assert.match(successDispatcher, /from '\.\/success-matrix\.ts'/, 'Success dispatcher must use the Gateway-owned matrix response handler');

for (const file of ['success-image.ts', 'success-matrix.ts', 'success-object.ts', 'success-stream.ts']) {
  const source = readFileSync(join(root, 'apps/gateway/attempt', file), 'utf8');
  assert.ok(source.includes("from './success.ts'"), `${file} must use the Gateway-owned SuccessArgs type`);
}
for (const file of ['inference-dispatch.ts', 'generation-dispatch.ts']) {
  const source = readFileSync(join(root, 'apps/gateway/attempt', file), 'utf8');
  assert.ok(source.includes("from './success.ts'"), `${file} must call Gateway-owned success finalizer`);
}

// Every physical upstream attempt must settle once through the unique
// Gateway owner; old request modules cannot maintain parallel mutable state.
const attemptObservationOwner = readFileSync(join(root, 'apps/gateway/attempt/observability.ts'), 'utf8');
const attemptObservationLegacy = readFileSync(join(root, 'src/request/attempt/observability.ts'), 'utf8');
assert.ok(
  attemptObservationLegacy.includes("export * from '../../../apps/gateway/attempt/observability.ts';"),
  'Legacy attempt observation must re-export its Gateway owner',
);
assert.doesNotMatch(attemptObservationLegacy, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
for (const symbol of ['observeUpstreamAttemptUsage', 'recordTokens', 'recordUndeliveredUpstreamAttempt']) {
  assert.ok(attemptObservationOwner.includes(`export function ${symbol}(`), `Gateway must own ${symbol}`);
}
assert.ok(attemptObservationOwner.includes("from './body-release.ts'"), 'Accounting must use Gateway body release');
assert.ok(attemptObservationOwner.includes("from '../response/response-helpers.ts'"), 'Accounting must reuse Gateway response helpers');
for (const name of ['generation-dispatch.ts', 'inference-dispatch.ts']) {
  const path = `apps/gateway/attempt/${name}`;
  const consumer = readFileSync(join(root, path), 'utf8');
  assert.ok(consumer.includes("from './observability.ts'"), `${path} must share Gateway accounting`);
  assert.doesNotMatch(consumer, /from ['"]\.\.\/\.\.\/\.\.\/src\/request\/attempt\/observability\.ts['"]/);
}
for (const name of ['success-image.ts', 'success-matrix.ts', 'success-object.ts', 'success-stream.ts']) {
  const path = `apps/gateway/attempt/${name}`;
  const consumer = readFileSync(join(root, path), 'utf8');
  assert.ok(consumer.includes("from './observability.ts'"), `${path} must reuse local Gateway accounting`);
  assert.doesNotMatch(consumer, /from ['"]\.\.\/\.\.\/\.\.\/src\/request\/attempt\/observability\.ts['"]/);
}

// Failure, rotation and adaptive 429 state belong to one Gateway owner.
const legacyOutcome = readFileSync(join(root, 'src/request/attempt/outcome.ts'), 'utf8');
const ownedOutcome = readFileSync(join(root, 'apps/gateway/attempt/outcome.ts'), 'utf8');
assert.ok(legacyOutcome.includes("export * from '../../../apps/gateway/attempt/outcome.ts';"), 'Old outcome path must forward');
assert.doesNotMatch(legacyOutcome, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
for (const name of ['rotateWithNeutralEnd', 'noteFailure', 'hedgeLoserOutcome', 'recordOutcome']) {
  assert.ok(ownedOutcome.includes(`export function ${name}(`), `Gateway must own ${name}`);
}
for (const invariant of ['nextAdaptive429CooldownMs(', 'snapshotAdaptive429State(', 'rate_limit_stage=']) {
  assert.ok(ownedOutcome.includes(invariant), `Adaptive 429 outcome must preserve ${invariant}`);
}
assert.ok(ownedOutcome.includes("from './observability.ts'"), 'Outcome must share unique Gateway attempt accounting');
assert.ok(ownedOutcome.includes("from '../response/response-helpers.ts'"), 'Outcome must reuse Gateway response helpers');
for (const file of ['success-image.ts', 'success-matrix.ts', 'success-object.ts', 'success-stream.ts']) {
  const code = readFileSync(join(root, 'apps/gateway/attempt', file), 'utf8');
  assert.ok(code.includes("from './outcome.ts'"), `${file} must call Gateway-owned outcome`);
}
for (const file of ['inference-dispatch.ts', 'generation-dispatch.ts']) {
  const code = readFileSync(join(root, 'apps/gateway/attempt', file), 'utf8');
  assert.ok(code.includes("from './outcome.ts'"), `${file} must call Gateway-owned outcome`);
}

// Private-center request adapters belong to Gateway, never to legacy src.
for (const [name, functionName] of [
  ['inference-dispatch', 'dispatchInferenceAttempt'],
  ['generation-dispatch', 'dispatchGenerationAttempt'],
]) {
  const legacy = readFileSync(join(root, `src/request/attempt/${name}.ts`), 'utf8');
  const owner = readFileSync(join(root, `apps/gateway/attempt/${name}.ts`), 'utf8');
  assert.ok(legacy.includes(`export * from '../../../apps/gateway/attempt/${name}.ts';`), `Old ${name} path must forward to Gateway owner`);
  assert.doesNotMatch(legacy, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
  assert.ok(owner.includes(`export async function ${functionName}(`), `Gateway must implement ${functionName}`);
  assert.ok(owner.includes("from '../transport/"), `${name} must delegate only through the private center client`);
  assert.ok(owner.includes("from './success.ts'"), `${name} must reuse the same Gateway success finalizer`);
  assert.ok(owner.includes("from './outcome.ts'"), `${name} must reuse the same Gateway failure finalizer`);
  assert.doesNotMatch(owner, /dispatchLegacyProvider|buildUpstreamHeadersFor|resolveSubscriptionCredential/);
}
const gatewayAttemptSelector = readFileSync(join(root, 'apps/gateway/attempt/dispatch.ts'), 'utf8');
assert.ok(gatewayAttemptSelector.includes("from './inference-dispatch.ts'"));
assert.ok(gatewayAttemptSelector.includes("from './generation-dispatch.ts'"));

// Tier 1 KV affinity and P2C candidate selection are Gateway-owned.
// Legacy imports share one cache, breaker, score and admission state.
for (const [name, exported] of [
  ['tier1-affinity', ['resolveTier1SessionId', 'readTier1Affinity', 'writeTier1Affinity', '__resetTier1AffinityForTests']],
  ['tier1-scheduler', ['pickTier1Candidate', 'tier1ModelAvailability', 'tier1DeadlineTooSmall']],
]) {
  const old = readFileSync(join(root, `src/scheduler/${name}.ts`), 'utf8');
  const actual = readFileSync(join(root, `apps/gateway/scheduling/${name}.ts`), 'utf8');
  assert.ok(old.includes(`export * from '../../apps/gateway/scheduling/${name}.ts';`), `${name} legacy path must forward`);
  assert.doesNotMatch(old, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
  for (const symbol of exported) {
    assert.match(actual, new RegExp(`export (?:async )?function ${symbol}\\(`), `${name} must implement ${symbol}`);
  }
}
const ownedTier1Affinity = readFileSync(join(root, 'apps/gateway/scheduling/tier1-affinity.ts'), 'utf8');
const ownedTier1Selector = readFileSync(join(root, 'apps/gateway/scheduling/tier1-scheduler.ts'), 'utf8');
assert.match(ownedTier1Affinity, /CACHE_MAX_ENTRIES = 500/, 'Session affinity cache must remain bounded');
assert.match(ownedTier1Affinity, /BREAKER_TRIP_TIMEOUTS = 5/, 'Affinity KV breaker must remain fail-soft');
assert.ok(ownedTier1Affinity.includes("from '../../../packages/contracts/runtime.ts'"), 'Affinity must use shared runtime types');
assert.ok(ownedTier1Selector.includes("from './tier1-affinity.ts'"), 'Tier 1 P2C must share one affinity state');
assert.ok(ownedTier1Selector.includes("from '../../../src/scheduler/tier1-scoring.ts'"), 'Tier 1 P2C must preserve existing scoring');
const tier1GatewayRequest = readFileSync(join(root, 'apps/gateway/request-handler.ts'), 'utf8');
const tier1GatewayLoop = readFileSync(join(root, 'apps/gateway/tier-loop.ts'), 'utf8');
const tier1GatewayHedge = readFileSync(join(root, 'apps/gateway/attempt/hedge.ts'), 'utf8');
assert.ok(tier1GatewayRequest.includes("from './scheduling/tier1-affinity.ts'"));
assert.ok(tier1GatewayRequest.includes("from './scheduling/tier1-scheduler.ts'"));
assert.ok(tier1GatewayLoop.includes("from './scheduling/tier1-affinity.ts'"));
assert.ok(tier1GatewayHedge.includes("from '../scheduling/tier1-scheduler.ts'"));

// Tier 2/3 dynamic selection and request eligibility share a single
// Gateway-owned implementation. Legacy import paths only re-export it.
const tier23Compat = readFileSync(join(root, 'src/scheduler/scheduler.ts'), 'utf8');
const tier23Owner = readFileSync(join(root, 'apps/gateway/scheduling/scheduler.ts'), 'utf8');
assert.ok(
  tier23Compat.includes("export * from '../../apps/gateway/scheduling/scheduler.ts';"),
  'Old Tier 2/3 scheduler must forward to the Gateway owner',
);
assert.doesNotMatch(
  tier23Compat,
  /^(?:import|export (?:async )?(?:function|const|class|type)) /m,
  'Old Tier 2/3 scheduler must not duplicate implementation or state',
);
for (const symbol of ['supportsRequest', 'pickCandidate', 'tierHasDispatchableNode', 'countDispatchableNodes']) {
  assert.match(tier23Owner, new RegExp(`export function ${symbol}\\(`), `Gateway must own Tier 2/3 ${symbol}`);
}
assert.match(tier23Owner, /from '..\/..\/..\/src\/reliability\/node-state.ts'/, 'Tier 2/3 must reuse existing node admission state');
assert.ok(
  readFileSync(join(root, 'apps/gateway/request-handler.ts'), 'utf8').includes("from './scheduling/scheduler.ts'"),
  'Gateway request preflight must call its owned eligibility implementation',
);
assert.ok(
  readFileSync(join(root, 'apps/gateway/attempt/hedge.ts'), 'utf8').includes("from '../scheduling/scheduler.ts'"),
  'Gateway hedge must call its owned Tier 2/3 picker',
);
assert.doesNotMatch(tier23Owner, /dispatchLegacyProvider|fetch\(/, 'Scheduler must not execute physical Provider requests');

// Tier 1 long-lived cooldown KV coordination is Gateway-owned. The old
// reliability path is a pure forwarding entry so tests, old callers and the
// active Gateway share the same in-memory cache, refresh state and writer.
const sharedCooldownCompat = readFileSync(join(root, 'src/reliability/tier1-shared-cooldowns.ts'), 'utf8');
const sharedCooldownOwner = readFileSync(join(root, 'apps/gateway/reliability/tier1-shared-cooldowns.ts'), 'utf8');
assert.ok(
  sharedCooldownCompat.includes("export * from '../../apps/gateway/reliability/tier1-shared-cooldowns.ts';"),
  'Old Tier 1 shared cooldown path must re-export its Gateway owner',
);
assert.doesNotMatch(
  sharedCooldownCompat,
  /^(?:import|export (?:async )?(?:function|const|class|type)|(?:const|let) )/m,
  'The old Tier 1 cooldown path may not keep another implementation or isolate state',
);
for (const symbol of ['hydrateSharedTier1Cooldowns', 'shareLongTier1Cooldowns', '__resetSharedTier1CooldownsForTests']) {
  assert.ok(sharedCooldownOwner.includes(`function ${symbol}(`), `Gateway must own Tier 1 cooldown ${symbol}`);
}
assert.ok(
  sharedCooldownOwner.includes("from '../../../packages/contracts/runtime.ts'") &&
    sharedCooldownOwner.includes("from '../../../src/reliability/tier1-state.ts'"),
  'Gateway cooldown sharing must reuse the neutral binding type and the existing single Tier 1 state',
);
for (const required of [
  'const REFRESH_MS = 5 * 60_000;',
  'const READ_TIMEOUT_MS = 50;',
  'let known: Tier1SharedCooldown[] = [];',
  'let isWriting = false;',
  'let isDirty = false;',
  'Promise.race([load, timeout])',
  'while (isDirty)',
  'adoptTier1Cooldown(entry)',
]) {
  assert.ok(sharedCooldownOwner.includes(required), `Shared Tier 1 cooldown behavior must be preserved: ${required}`);
}
assert.ok(
  readFileSync(join(root, 'apps/gateway/request-handler.ts'), 'utf8').includes("from './reliability/tier1-shared-cooldowns.ts'") &&
    readFileSync(join(root, 'apps/gateway/attempt/outcome.ts'), 'utf8').includes("from '../reliability/tier1-shared-cooldowns.ts'"),
  'Gateway ingress and physical attempt outcome must call the same owned cooldown module directly',
);
const tierPolicyOwner = readFileSync(join(root, 'apps/gateway/scheduling/tier-policy.ts'), 'utf8');
assert.ok(
  tierPolicyOwner.includes("from './scheduler.ts'") && !tierPolicyOwner.includes("from '../../../src/scheduler/scheduler.ts'"),
  'Tier budget policy must use the Gateway-owned Tier 2/3 selector rather than the legacy facade',
);

// The hedge race and private-center selector are Gateway-owned. Old entry
// points are compatibility only, and all live callers reach the same code.
for (const [name, symbol] of [
  ['dispatch', 'attemptNode'],
  ['hedge', 'dispatchWithHedge'],
]) {
  const legacy = readFileSync(join(root, `src/request/attempt/${name}.ts`), 'utf8');
  const owner = readFileSync(join(root, `apps/gateway/attempt/${name}.ts`), 'utf8');
  assert.ok(legacy.includes(`export * from '../../../apps/gateway/attempt/${name}.ts';`), `Old ${name} module must forward to its Gateway owner`);
  assert.doesNotMatch(legacy, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
  assert.ok(owner.includes(`export async function ${symbol}(`), `Gateway must implement ${symbol}`);
}
const ownedDispatch = readFileSync(join(root, 'apps/gateway/attempt/dispatch.ts'), 'utf8');
const ownedHedge = readFileSync(join(root, 'apps/gateway/attempt/hedge.ts'), 'utf8');
assert.ok(ownedDispatch.includes("from './observability.ts'"), 'Gateway dispatch must share physical settlement');
assert.ok(ownedHedge.includes("from './dispatch.ts'"), 'Hedge must invoke the unique Gateway attempt selector');
assert.match(ownedHedge, /attemptDeadlineMs:\s*primaryArgs\.attemptDeadlineMs/, 'Hedge twins must share the primary deadline');
const legacyAttemptIndex = readFileSync(join(root, 'src/request/attempt/index.ts'), 'utf8');
assert.ok(legacyAttemptIndex.includes("from '../../../apps/gateway/attempt/dispatch.ts'"));
assert.ok(legacyAttemptIndex.includes("from '../../../apps/gateway/attempt/hedge.ts'"));
const gatewayTierLoopOwner = readFileSync(join(root, 'apps/gateway/tier-loop.ts'), 'utf8');
assert.ok(gatewayTierLoopOwner.includes("from './attempt/hedge.ts'"), 'Tier loop must call owned Gateway hedge');

// Gateway owns safe large-body release, buffered response decisions, and
// terminal oversized-reply handling; legacy modules are compatibility-only.
for (const [legacy, owner, symbol] of [
  ['src/request/attempt/body-release.ts', 'apps/gateway/attempt/body-release.ts', 'releaseLargeRequestBody'],
  ['src/request/attempt/attempt-mode.ts', 'apps/gateway/attempt/attempt-mode.ts', 'isBufferedUpstreamReply'],
  ['src/request/attempt/oversize.ts', 'apps/gateway/attempt/oversize.ts', 'stopOnOversizedReply'],
]) {
  const shim = readFileSync(join(root, legacy), 'utf8');
  const impl = readFileSync(join(root, owner), 'utf8');
  assert.ok(shim.includes(`export * from '../../../${owner}';`), `${legacy} must be a pure compatibility export`);
  assert.doesNotMatch(shim, /^(?:import|export (?:async )?(?:function|const|class)) /m, `${legacy} must not duplicate implementation`);
  assert.ok(impl.includes(`export function ${symbol}(`), `${owner} must own ${symbol}`);
}
assert.ok(attemptObservationOwner.includes("from './body-release.ts'"), 'Attempt observation must use Gateway-owned body release directly');
assert.ok(
  readFileSync(join(root, 'apps/gateway/attempt/dispatch.ts'), 'utf8').includes("from './attempt-mode.ts'"),
  'Attempt dispatch must export Gateway-owned buffering decision directly',
);
// Buffered response completion must be Gateway-owned; old imports are shims.
const legacyObjectSuccess = readFileSync(join(root, 'src/request/attempt/success-object.ts'), 'utf8');
const ownedObjectSuccess = readFileSync(join(root, 'apps/gateway/attempt/success-object.ts'), 'utf8');
assert.ok(
  legacyObjectSuccess.includes("export * from '../../../apps/gateway/attempt/success-object.ts';"),
  'Legacy object success must forward to the sole Gateway-owned implementation',
);
assert.doesNotMatch(legacyObjectSuccess, /^(?:import|export (?:async )?(?:function|const|class|type)) /m);
assert.match(ownedObjectSuccess, /export async function handleObjectSuccess\(/);
assert.ok(ownedObjectSuccess.includes("from './oversize.ts'"), 'Gateway object reply must use Gateway oversized handling');
assert.ok(ownedObjectSuccess.includes("from '../response/errors.ts'"), 'Gateway object reply must use owned errors');
assert.ok(ownedObjectSuccess.includes("from '../response/response-helpers.ts'"), 'Gateway object reply must use owned response helpers');
assert.ok(ownedObjectSuccess.includes("from './observability.ts'"), 'Object completion must preserve physical attempt usage accounting');
assert.ok(successDispatcher.includes("from './success-object.ts'"), 'Success dispatcher must call Gateway-owned object handler');

const oversizedResponseSource = readFileSync(join(root, 'apps/gateway/attempt/oversize.ts'), 'utf8');
assert.ok(oversizedResponseSource.includes("from '../response/errors.ts'"), 'Gateway oversized reply must use its owned response module');

// Native stream finalization uses Gateway response helpers and keeps the
// first-event guard in its one real owner, not the compatibility facade.
const ownedStreamSuccess = readFileSync(join(root, 'apps/gateway/attempt/success-stream.ts'), 'utf8');
assert.match(ownedStreamSuccess, /export async function handleStreamingSuccess\(/);
assert.match(ownedStreamSuccess, /ensureFirstSseEvent\(/);
assert.match(ownedStreamSuccess, /trackStreamResponse\(/);
assert.ok(ownedStreamSuccess.includes("from '../response/errors.ts'"));
assert.ok(ownedStreamSuccess.includes("from '../response/response-helpers.ts'"));
assert.ok(ownedStreamSuccess.includes("from './observability.ts'"));

// Gateway alone owns client-facing error shaping, Retry-After policy and
// response headers. The former src/request paths must never implement them.
for (const [legacy, owner, symbol] of [
  ['src/request/errors.ts', 'apps/gateway/response/errors.ts', 'gatewayError'],
  ['src/request/response-helpers.ts', 'apps/gateway/response/response-helpers.ts', 'finalHeaders'],
]) {
  const shim = readFileSync(join(root, legacy), 'utf8');
  const actual = readFileSync(join(root, owner), 'utf8');
  const relativeOwner = owner.replace(/^apps\/gateway\//, '../../apps/gateway/');
  assert.ok(shim.includes(`export * from '${relativeOwner}';`), `${legacy} must be a pure compatibility export`);
  assert.doesNotMatch(
    shim,
    /^(?:import|export (?:async )?(?:function|const|class)) /m,
    `${legacy} must not own a second Gateway error/response implementation`,
  );
  assert.ok(actual.includes(`export function ${symbol}(`), `${owner} must implement ${symbol}`);
}
for (const path of [
  'apps/gateway/preflight.ts',
  'apps/gateway/request-handler.ts',
  'apps/gateway/fallback.ts',
  'apps/gateway/tier-loop.ts',
  'apps/gateway/attempt/outcome.ts',
  'apps/gateway/attempt/inference-dispatch.ts',
  'apps/gateway/attempt/generation-dispatch.ts',
]) {
  const consumer = readFileSync(join(root, path), 'utf8');
  const prefix = path.startsWith('apps/gateway/attempt/')
    ? '../response/'
    : path.startsWith('apps/')
      ? './response/'
      : '../../../apps/gateway/response/';
  assert.ok(
    consumer.includes(`from '${prefix}errors.ts'`) || consumer.includes(`from '${prefix}response-helpers.ts'`),
    `${path} must consume the Gateway-owned response implementation directly`,
  );
  assert.doesNotMatch(
    consumer,
    /from ['"][^'"]*\/src\/request\/(?:errors|response-helpers)\.ts['"]|from ['"]\.\.\/(?:errors|response-helpers)\.ts['"]/,
    `${path} must not depend on old request response paths`,
  );
}
const gatewayErrors = readFileSync(join(root, 'apps/gateway/response/errors.ts'), 'utf8');
assert.match(gatewayErrors, /shouldNotRetryHeaders/, 'Gateway error handler must preserve x-should-retry behavior');
assert.match(gatewayErrors, /responsesErrorResponse/, 'Gateway errors must preserve the OpenAI Responses error shape');
assert.match(gatewayErrors, /exposeUpstreamInfo|shouldExposeUpstreamInfo/, 'Gateway errors must preserve upstream topology privacy');

const handlerSource = readFileSync(join(root, 'src/request/handler.ts'), 'utf8');
const tierLoopSource = readFileSync(join(root, 'apps/gateway/tier-loop.ts'), 'utf8');
const fallbackShim = readFileSync(join(root, 'src/request/fallback.ts'), 'utf8');
const fallbackOwner = readFileSync(join(root, 'apps/gateway/fallback.ts'), 'utf8');
const gatewayHandler = readFileSync(join(root, 'apps/gateway/request-handler.ts'), 'utf8');
assert.ok(fallbackShim.includes("from '../../apps/gateway/fallback.ts'"), 'Legacy fallback must only re-export Gateway-owned implementation');
assert.ok(
  !fallbackShim.includes('convertMatrixRequest') && !fallbackShim.includes('for (const fb of fallbacks)'),
  'Old fallback must not duplicate orchestration',
);
assert.ok(gatewayHandler.includes("from './fallback.ts'"), 'Gateway orchestrator must import its owned fallback');
assert.ok(!gatewayHandler.includes('src/request/fallback.ts'), 'Gateway must not call legacy fallback');
assert.ok(fallbackOwner.includes('export async function runFallbackChain('), 'Gateway must own fallback policy');
assert.ok(fallbackOwner.includes('computeTierCaps'), 'Fallback must reuse Gateway request-wide Tier attempt budget');

assert.match(handlerSource, /apps\/gateway\/request-handler\.ts/, 'Legacy handler must forward to Gateway-owned module');
assert.match(
  readFileSync(join(root, 'apps/gateway/request-handler.ts'), 'utf8'),
  /async function runAdmittedRequest\(/,
  'Gateway must own request orchestrator',
);
assert.match(
  readFileSync(join(root, 'src/request/preflight.ts'), 'utf8'),
  /apps\/gateway\/preflight\.ts/,
  'Legacy preflight must forward to Gateway-owned module',
);
assert.match(readFileSync(join(root, 'apps/gateway/preflight.ts'), 'utf8'), /export async function preflight\(/, 'Gateway must own preflight');
assert.doesNotMatch(
  readFileSync(join(root, 'apps/gateway/index.ts'), 'utf8'),
  /\.\.\/\.\.\/src\/request\/handler/,
  'Gateway entry must use owned orchestrator',
);
assert.doesNotMatch(handlerSource, /async function runTierLoop\(/, 'Request handler must not reimplement the Tier loop');
assert.match(tierLoopSource, /export async function runTierLoop\(/, 'Gateway must own the Tier loop implementation');
assert.doesNotMatch(tierLoopSource, /getProviderAdapter|resolveSubscriptionCredential/, 'Tier loop must not own Provider implementation');
for (const center of ['inference', 'generation']) {
  const entry = readFileSync(join(root, 'apps', center, 'index.ts'), 'utf8');
  const executor = readFileSync(join(root, 'apps', center, 'execution.ts'), 'utf8');
  assert.doesNotMatch(
    entry,
    /getProviderAdapter|resolveSubscriptionCredential|await fetch\(/,
    `${center} HTTP entrypoint must not own physical Provider execution`,
  );
  assert.ok(entry.includes("from './execution.ts'"), `${center} entrypoint must call its own executor`);
  assert.match(executor, /await fetch\(/, `${center} must own a physical Provider attempt`);
  assert.doesNotMatch(executor, /runTierLoop|dispatchWithHedge/, `${center} must not implement gateway scheduling`);
}
const nodeConfigSource = readFileSync(join(root, 'src/config/nodes.ts'), 'utf8');
assert.doesNotMatch(nodeConfigSource, /getProviderAdapter|providerWire\(/, 'Node config must not load Provider implementations');
assert.match(nodeConfigSource, /getProviderProfile/, 'Node config must use a credential-free Provider profile');
assert.match(nodeConfigSource, /const isGatewayInferenceCenterOwned = shouldRequireClientKey;/, 'Gateway must always be metadata-only');
assert.match(
  nodeConfigSource,
  /isGatewayInferenceCenterOwned \? \[\] : sortedSecretShards/,
  'Public Gateway must never parse or retain physical Provider credentials',
);

const imagePreflight = readFileSync(join(root, 'apps/gateway/preflight.ts'), 'utf8');
const imageExecutor = readFileSync(join(root, 'apps/generation/execution.ts'), 'utf8');
assert.doesNotMatch(imagePreflight, /getProviderAdapter/, 'Gateway preflight must not execute Provider image adapters');
assert.match(imagePreflight, /canRouteImageGeneration/, 'Gateway must use the shared image capability declaration');
assert.match(imageExecutor, /isImageGenerationProvider/, 'Generation Center must enforce the same Provider capability declaration');

const dispatchSource = readFileSync(join(root, 'apps/gateway/attempt/dispatch.ts'), 'utf8');
assert.doesNotMatch(
  dispatchSource,
  /await fetch\(|resolveSubscriptionCredential|getProviderAdapter|buildUpstreamHeadersFor|dispatchLegacyProvider/,
  'Gateway attempts must not execute Provider logic or reference any legacy direct transport',
);
assert.match(
  dispatchSource,
  /if \(route === 'openai_images'\) return dispatchGenerationAttempt\(c\);/,
  'Image generation must always route through Generation Center',
);
assert.match(
  dispatchSource,
  /return dispatchInferenceAttempt\(c, sourceBody, 'inference'\);/,
  'Text inference must route through the private Inference Center',
);
assert.match(
  dispatchSource,
  /return dispatchInferenceAttempt\(c, sourceBody, 'perception'\);/,
  'Declared image input must use the private Perception Center',
);
assert.match(dispatchSource, /hasImageInput\(bodyJson\)/, 'Perception routing must require actual image-bearing input');
assert.match(dispatchSource, /capabilities\.vision === true/, 'Perception routing must require explicit catalog vision capability');
assert.match(dispatchSource, /getProviderProfile\(node\.provider\)\.imageInput/, 'Perception routing must require explicit provider image support');
assert.doesNotMatch(dispatchSource, /rotateWithNeutralEnd\(state,/, 'Provider filtering must use the current attempt state');
assert.doesNotMatch(dispatchSource, /AIG_INFERENCE_ACTIVE|AIG_GENERATION_ACTIVE/, 'No runtime switch may re-enable direct Provider execution');
assert.ok(
  !existsSync(join(root, 'src/request/attempt/legacy-provider-dispatch.ts')),
  'Legacy direct Provider dispatcher must be deleted, not retained behind a flag',
);
for (const [shim, target] of [
  ['src/conversion/matrix/ir.ts', '../../../packages/conversion-core/ir.ts'],
  ['src/conversion/matrix/budget.ts', '../../../packages/conversion-core/budget.ts'],
  ['src/conversion/matrix/diag.ts', '../../../packages/conversion-core/diag.ts'],
  ['src/conversion/result.ts', '../../packages/conversion-core/result.ts'],
  ['src/conversion/validation.ts', '../../packages/conversion-core/validation.ts'],
]) {
  const compat = readFileSync(join(root, shim), 'utf8');
  assert.ok(
    compat.includes(`export * from '${target}';`),
    `Conversion implementation must live in its independent package, with only a compatibility export at ${shim}`,
  );
}

// All Chat conversion implementations belong to the Inference Center.
// Legacy paths can re-export them but cannot carry duplicate conversion code.
for (const [shim, owner] of [
  ['src/conversion/matrix/chat.ts', '../../../apps/inference/conversion/chat.ts'],
  ['src/conversion/matrix/chat-stream.ts', '../../../apps/inference/conversion/chat-stream.ts'],
]) {
  const compatibility = readFileSync(join(root, shim), 'utf8');
  assert.ok(compatibility.includes(`export * from '${owner}';`), `Chat converter compatibility export missing: ${shim}`);
  assert.doesNotMatch(compatibility, /export (?:function|class) /, `Chat conversion implementation duplicated: ${shim}`);
}
for (const file of ['apps/inference/conversion/chat.ts', 'apps/inference/conversion/chat-stream.ts']) {
  const owner = readFileSync(join(root, file), 'utf8');
  assert.doesNotMatch(owner, /from ['"][^'"]*\/src\//, `Inference codec imports legacy src: ${file}`);
}

for (const [shim, owner] of [
  ['src/conversion/matrix/anthropic.ts', '../../../apps/inference/conversion/anthropic.ts'],
  ['src/conversion/matrix/anthropic-stream.ts', '../../../apps/inference/conversion/anthropic-stream.ts'],
]) {
  const compatibility = readFileSync(join(root, shim), 'utf8');
  assert.ok(compatibility.includes(`export * from '${owner}';`), `Anthropic conversion compatibility export missing: ${shim}`);
  assert.doesNotMatch(compatibility, /export (?:function|class) /, `Anthropic conversion implementation duplicated: ${shim}`);
}
for (const file of ['apps/inference/conversion/anthropic.ts', 'apps/inference/conversion/anthropic-stream.ts']) {
  const owner = readFileSync(join(root, file), 'utf8');
  assert.doesNotMatch(owner, /from ['"][^'"]*\/src\//, `Inference codec imports legacy src: ${file}`);
}

// Responses converters and pure SSE event builder must not regress to src.
for (const [shim, owner] of [
  ['src/conversion/matrix/responses.ts', '../../../apps/inference/conversion/responses.ts'],
  ['src/conversion/matrix/responses-stream.ts', '../../../apps/inference/conversion/responses-stream.ts'],
  ['src/protocol/responses/events.ts', '../../../packages/conversion-core/responses-events.ts'],
]) {
  const compatibility = readFileSync(join(root, shim), 'utf8');
  assert.ok(compatibility.includes(`export * from '${owner}';`), `Responses compatibility export missing: ${shim}`);
  assert.doesNotMatch(compatibility, /export (?:function|class) /, `Responses implementation duplicated: ${shim}`);
}
for (const file of [
  'apps/inference/conversion/responses.ts',
  'apps/inference/conversion/responses-stream.ts',
  'packages/conversion-core/responses-events.ts',
]) {
  const owner = readFileSync(join(root, file), 'utf8');
  assert.doesNotMatch(owner, /from ['"][^'"]*\/src\//, `Responses implementation imports legacy src: ${file}`);
}

// A single Inference-owned implementation must serve every request conversion.
const matrixRequestOwner = readFileSync(join(root, 'apps/inference/conversion/request.ts'), 'utf8');
const matrixPipelineCompat = readFileSync(join(root, 'src/conversion/matrix/pipeline.ts'), 'utf8');
assert.ok(
  matrixPipelineCompat.includes("export * from '../../../apps/inference/conversion/request.ts';"),
  'Old matrix request pipeline must export the same inference-owned request converter',
);
assert.doesNotMatch(matrixPipelineCompat, /export function convertMatrixRequest\(/, 'Do not duplicate conversion in Gateway');
assert.match(matrixRequestOwner, /export function convertMatrixRequest\(/, 'Inference must own protocol request conversion');
assert.doesNotMatch(matrixRequestOwner, /from ['"][^'"]*\/src\//, 'Request conversion must only use shared contracts and local codecs');

// Native reply decode/render is a single Inference-owned implementation.
const matrixReplyOwner = readFileSync(join(root, 'apps/inference/conversion/response.ts'), 'utf8');
const matrixReplyLegacy = readFileSync(join(root, 'src/conversion/matrix/pipeline.ts'), 'utf8');
assert.match(matrixReplyOwner, /export function replyFromNativeObject\(/, 'Inference must decode native reply objects');
assert.match(matrixReplyOwner, /export function replyToObject\(/, 'Inference must render reply objects');
assert.doesNotMatch(matrixReplyLegacy, /export function replyToObject\(/, 'Gateway must not own duplicate object rendering');
assert.doesNotMatch(matrixReplyLegacy, /export function replyFromNativeObject\(/, 'Gateway must not own duplicate object decoding');
assert.ok(
  matrixReplyLegacy.includes("export * from '../../../apps/inference/conversion/response.ts';"),
  'Old Matrix replies must use one inference-owned implementation',
);
assert.doesNotMatch(matrixReplyOwner, /from ['"][^'"]*\/src\//, 'Inference object conversion must not import legacy src');

// SSE parsing, deadline reads and conversion relay must use one shared owner.
for (const [shim, owner] of [
  ['src/conversion/sse.ts', '../../packages/transport/convert-sse.ts'],
  ['src/stream/client-lifecycle.ts', '../../packages/transport/client-lifecycle.ts'],
]) {
  const compatibility = readFileSync(join(root, shim), 'utf8');
  assert.ok(compatibility.includes(owner), `SSE compatibility export missing: ${shim}`);
  assert.doesNotMatch(compatibility, /export function /, `Duplicate SSE implementation: ${shim}`);
}
const streamGuard = readFileSync(join(root, 'src/stream/guard.ts'), 'utf8');
assert.ok(streamGuard.includes("from '../../packages/transport/sse.ts'"), 'Gateway guard must use shared SSE parser');
assert.doesNotMatch(streamGuard, /function drainLines\(/, 'Gateway must not duplicate SSE scanner implementation');
for (const file of ['packages/transport/sse.ts', 'packages/transport/convert-sse.ts', 'packages/transport/client-lifecycle.ts']) {
  assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /from ['"][^'"]*\/src\//, `Transport must not import legacy src: ${file}`);
}

// No Gateway-side duplicate Matrix SSE lifecycle or reverse Inference -> src imports.
const matrixLegacyPipeline = readFileSync(join(root, 'src/conversion/matrix/pipeline.ts'), 'utf8');
const inferenceStreamOwner = readFileSync(join(root, 'apps/inference/conversion/stream.ts'), 'utf8');
assert.ok(
  matrixLegacyPipeline.includes("export * from '../../../apps/inference/conversion/stream.ts';"),
  'Old Matrix SSE pipeline must only re-export the Inference implementation',
);
assert.doesNotMatch(matrixLegacyPipeline, /export (?:async )?function /, 'Gateway Matrix pipeline must have no executor logic');
for (const functionName of ['openMatrixStream', 'collectMatrixObject', 'synthesizeMatrixStreamFromObject']) {
  assert.ok(
    inferenceStreamOwner.includes(`export ${functionName === 'collectMatrixObject' ? 'async ' : ''}function ${functionName}(`),
    `Inference must own Matrix SSE ${functionName}`,
  );
}
assert.doesNotMatch(inferenceStreamOwner, /from ['"][^'"]*\/src\//, 'Inference Matrix stream may use only neutral packages and local codecs');
assert.doesNotMatch(
  inferenceStreamOwner,
  /ensureFirstSseEvent|dispatchWithHedge|runTierLoop/,
  'Inference stream codec must not own Gateway commit/failover',
);

const inferenceExecutor = readFileSync(join(root, 'apps/inference/execution.ts'), 'utf8');
const centerDispatch = readFileSync(join(root, 'apps/gateway/attempt/inference-dispatch.ts'), 'utf8');
assert.match(inferenceExecutor, /convertMatrixRequest\(from, to, clientBody/, 'Inference must execute the physical protocol request conversion');
assert.match(inferenceExecutor, /highRiskSemanticLoss\(converted\)/, 'Center must recheck high-risk fidelity');
assert.match(centerDispatch, /c\.conversionContext \? c\.bodyJson : sourceBody/, 'Gateway must send original body for v2 center conversion');
const responseCenter = readFileSync(join(root, 'apps/inference/execution.ts'), 'utf8');
const responseGateway = readFileSync(join(root, 'apps/gateway/attempt/success-matrix.ts'), 'utf8');
const responseContract = readFileSync(join(root, 'packages/contracts/execution.ts'), 'utf8');
assert.match(responseCenter, /replyFromNativeObject\(upstreamProtocol, native\)/, 'Inference must decode native reply objects before forwarding');
assert.match(responseCenter, /replyToObject\(reply, clientProtocol\)/, 'Inference must render the client protocol for v3 objects');
assert.match(responseGateway, /isTranslatedObjectEnvelope\(native\)/, 'Gateway must strictly validate pretranslated objects');
assert.match(responseGateway, /recordTokens\(c, node, native.upstreamUsage\)/, 'Gateway must settle the physical upstream usage once');
assert.match(responseContract, /EXECUTION_OBJECT_CONTRACT_VERSION = '3'/, 'v3 object conversion must use its own contract version');
const inferencePreflight = readFileSync(join(root, 'apps/inference/preflight.ts'), 'utf8');
const delegatedFallback = readFileSync(join(root, 'apps/gateway/fallback.ts'), 'utf8');
const inferencePreflightClient = readFileSync(join(root, 'apps/gateway/transport/inference-preflight-client.ts'), 'utf8');
const legacyPreflightShim = readFileSync(join(root, 'src/inference/inference-preflight-client.ts'), 'utf8');
assert.match(inferencePreflight, /convertMatrixRequest\(/, 'Only Inference Center may run full conversion preflight when bound');
assert.match(delegatedFallback, /await checkInferenceConversion\(/, 'Bound Gateway must delegate fallback conversion preflight');
assert.match(
  delegatedFallback,
  /from '\.\/transport\/inference-preflight-client\.ts'/,
  'Gateway must directly import its owned private preflight client',
);
assert.match(inferencePreflightClient, /INFERENCE_PREFLIGHT_PATH/, 'Private preflight client must use its dedicated endpoint');
assert.ok(
  legacyPreflightShim.includes("from '../../apps/gateway/transport/inference-preflight-client.ts'"),
  'Legacy preflight import must only re-export the Gateway transport',
);
assert.doesNotMatch(legacyPreflightShim, /export async function /, 'Legacy preflight path must not duplicate execution logic');
assert.doesNotMatch(inferencePreflight, /fetch\(|dispatchWithHedge|runTierLoop/, 'Inference preflight cannot dispatch or schedule Provider calls');
// Internal framed streams must have one shared codec and must not carry
// private Provider accounting data directly to the public response.
const frameContract = readFileSync(join(root, 'packages/contracts/inference-stream-frames.ts'), 'utf8');
const frameProducer = readFileSync(join(root, 'apps/inference/conversion/framed-stream.ts'), 'utf8');
const frameConsumer = readFileSync(join(root, 'apps/gateway/transport/inference-stream-client.ts'), 'utf8');
const frameConsumerShim = readFileSync(join(root, 'src/inference/inference-stream-client.ts'), 'utf8');
assert.ok(
  frameConsumerShim.includes("from '../../apps/gateway/transport/inference-stream-client.ts'"),
  'Legacy inference frame decoder must be a Gateway compatibility export',
);
assert.doesNotMatch(frameConsumerShim, /export function /, 'Legacy frame decoder must not duplicate frame decoding');
assert.match(frameContract, /export function frameInferenceStream\(/, 'Private stream must have one framed encoder');
assert.match(frameContract, /export function unframeInferenceStream\(/, 'Private stream must require explicit Gateway decoding');
assert.match(frameProducer, /openMatrixStream\(/, 'Inference must execute real Matrix SSE conversion');
assert.match(frameProducer, /buildFramedMatrixObjectFallback\(/, 'Inference must own native JSON to framed SSE fallback');
assert.match(frameConsumer, /unframeInferenceStream\(/, 'Gateway decoder must strip private control frames');
assert.match(
  readFileSync(join(root, 'apps/gateway/attempt/success-matrix.ts'), 'utf8'),
  /from '\.\.\/transport\/inference-stream-client\.ts'/,
  'Gateway response handler must import its own private frame decoder',
);
assert.doesNotMatch(
  frameProducer,
  /ensureFirstSseEvent|recordTokens|runTierLoop/,
  'Inference frame producer must not own Gateway scheduling/accounting',
);
assert.doesNotMatch(frameContract, /from ['"][^'"]*\/src\//, 'Neutral frame contract cannot import legacy Gateway source');

const inferenceV4Contract = readFileSync(join(root, 'packages/contracts/execution.ts'), 'utf8');
const inferenceV4Executor = readFileSync(join(root, 'apps/inference/execution.ts'), 'utf8');
const inferenceV4Dispatcher = readFileSync(join(root, 'apps/gateway/attempt/inference-dispatch.ts'), 'utf8');
const inferenceV4Success = readFileSync(join(root, 'apps/gateway/attempt/success-matrix.ts'), 'utf8');
assert.match(inferenceV4Contract, /EXECUTION_STREAM_CONTRACT_VERSION = '4'/, 'v4 must have dedicated fail-closed execution contract');
assert.match(inferenceV4Executor, /buildFramedMatrixResponse\(/, 'Inference must execute real private streaming conversion');
assert.match(inferenceV4Executor, /buildFramedMatrixObjectFallback\(/, 'Inference must synthesize JSON fallback behind private frames');
assert.match(inferenceV4Dispatcher, /INFERENCE_FRAMED_STREAM_CONTENT_TYPE/, 'Gateway must reject unframed v4/v5 JSON fallback');
assert.match(inferenceV4Contract, /EXECUTION_BUDGET_STREAM_CONTRACT_VERSION = '5'/, 'v5 must isolate budgeted streams from legacy v4');
assert.ok(
  inferenceV4Dispatcher.includes('(returnStream || returnCollectedObject) && limits.conversionBudget'),
  'Matrix conversion budgets must be issued to private center v5/v6',
);
assert.match(inferenceV4Success, /decodeFramedInferenceResponse\(/, 'Gateway must strip private frames before commit');
assert.match(inferenceV4Success, /guardProtocol = clientIr/, 'Gateway must guard already-converted client SSE');
assert.doesNotMatch(inferenceV4Success, /from ['"][^'"]*\/conversion\/matrix\/pipeline\.ts['"]/, 'Gateway must not import the private IR pipeline');
assert.doesNotMatch(
  inferenceV4Success,
  /\b(?:replyFromNativeObject|replyToObject|collectMatrixObject|openMatrixStream|synthesizeMatrixStreamFromObject)\s*\(/,
  'Gateway must not execute local Matrix reply conversion',
);
assert.match(inferenceV4Success, /responseFormat !== INFERENCE_TRANSLATED_OBJECT_FORMAT/, 'Gateway must reject untagged converted objects');
assert.match(inferenceV4Success, /responseFormat !== INFERENCE_FRAMED_STREAM_FORMAT/, 'Gateway must reject unframed converted SSE');
const centerBudget = readFileSync(join(root, 'apps/inference/execution.ts'), 'utf8');
const budgetGateway = readFileSync(join(root, 'apps/gateway/attempt/inference-dispatch.ts'), 'utf8');
const budgetSettlement = readFileSync(join(root, 'apps/gateway/attempt/success-matrix.ts'), 'utf8');
assert.match(centerBudget, /streamFramingOptions\(invocation, to\)/, 'Inference must enforce v5 stream budgets');
assert.match(budgetGateway, /streamBudget,/, 'Gateway must issue bounded v5 budgets');
assert.match(budgetSettlement, /centerBudgetStop = reason/, 'Gateway must observe v5 private stop reasons');
assert.match(budgetSettlement, /budgetExceeded: \(\) => centerBudgetStop/, 'Gateway must settle v5 budget event once');
assert.match(responseContract, /EXECUTION_COLLECTED_OBJECT_CONTRACT_VERSION = '6'/, 'v6 must isolate center-owned nonstream SSE collection');
assert.match(centerDispatch, /returnCollectedObject = Boolean\(/, 'Gateway must request v6 for default nonstream Matrix calls');
assert.match(centerDispatch, /gateway_inference_object_format_invalid/, 'Gateway must reject untagged v6 objects and SSE');
assert.match(inferenceExecutor, /await collectMatrixObject\(/, 'Only private center may collect v6 SSE into a reply object');
assert.match(
  inferenceV4Contract,
  /CENTER_CONVERSION_BUDGET_EXCEEDED: 'center_conversion_budget_exceeded'/,
  'The shared execution contract must declare the v6 budget stop code',
);
assert.match(inferenceExecutor, /EXECUTION_ERROR_CODE\.CENTER_CONVERSION_BUDGET_EXCEEDED/, 'Center must signal v6 budget stop using the shared code');
assert.match(centerDispatch, /returnTranslatedObject = Boolean\(/, 'Gateway must verify tagged objects for both v3 and v6');
assert.match(centerDispatch, /returnTranslatedObject &&\s*\(upstream.headers.get/, 'Gateway must reject untagged v3/v6 responses');
assert.match(inferenceExecutor, /if \(invocation.returnObject && upstream.ok && content\?\.toLowerCase/, 'Inference must collect unexpected v3 SSE');
assert.doesNotMatch(
  inferenceExecutor,
  /if \(!invocation.preferNonstream\) return dispatchedConversionProblem/,
  'v3 cannot pass raw successful JSON back to Gateway',
);
// Scheduled maintenance is an application boundary. The D1 primitives
// shared with request-time accounting belong to the neutral usage-store package.
for (const [legacy, owner] of [
  ['src/observability/time-buckets.ts', '../../packages/usage-store/time-buckets.ts'],
  ['src/observability/token-usage-store/keys.ts', '../../../packages/usage-store/keys.ts'],
  ['src/observability/token-usage-store/statements.ts', '../../../packages/usage-store/statements.ts'],
  ['src/observability/token-usage-store/buffer.ts', '../../../packages/usage-store/buffer.ts'],
  ['src/observability/token-usage-store/aggregation.ts', '../../../operations/maintenance/aggregation.ts'],
]) {
  const compatibility = readFileSync(join(root, legacy), 'utf8');
  assert.ok(compatibility.includes(`export * from '${owner}'`), `${legacy} must delegate to its unique owner`);
  assert.doesNotMatch(
    compatibility,
    /export (?:async )?function |export (?:const|class) /,
    `Legacy usage module duplicates implementation: ${legacy}`,
  );
}
const operationsAggregation = readFileSync(join(root, 'operations/maintenance/aggregation.ts'), 'utf8');
const operationsRetention = readFileSync(join(root, 'operations/maintenance/retention.ts'), 'utf8');
assert.match(operationsAggregation, /export async function aggregateHourlyToDaily\(/, 'Operations must own hourly aggregation');
assert.match(operationsAggregation, /export async function aggregateDailyToWeekly\(/, 'Operations must own weekly aggregation');
assert.ok(
  operationsRetention.includes("import('./aggregation.ts')"),
  'Scheduled maintenance must use the Operations-owned aggregation implementation',
);
assert.ok(
  operationsRetention.includes("from '../../packages/usage-store/keys.ts'") &&
    operationsRetention.includes("from '../../packages/usage-store/buffer.ts'"),
  'Scheduled maintenance must consume neutral usage-store primitives directly',
);
const gatewaySource = readFileSync(join(root, 'apps/gateway/index.ts'), 'utf8');
assert.doesNotMatch(gatewaySource, /maintainUsageStats|async scheduled/, 'Gateway app must not own scheduled D1 maintenance');
const operationsSource = readFileSync(join(root, 'operations/index.ts'), 'utf8');
const compositionRoot = readFileSync(join(root, 'src/index.ts'), 'utf8');
assert.match(operationsSource, /from '\.\/maintenance\/usage\.ts'/, 'Operations must own the scheduled maintenance implementation');
assert.match(operationsSource, /export async function scheduled\(/, 'Operations must expose an independent scheduled entry');
// Usage aggregation and retention must have one Operations-owned executor.
// The former observability source path remains a compatibility export only.
const usageMaint = readFileSync(join(root, 'operations/maintenance/usage.ts'), 'utf8');
const retentionOwner = readFileSync(join(root, 'operations/maintenance/retention.ts'), 'utf8');
const retentionCompat = readFileSync(join(root, 'src/observability/token-usage-store/retention.ts'), 'utf8');
assert.match(usageMaint, /from '\.\/retention\.ts'/, 'Scheduled usage maintenance must call its Operations-owned executor');
assert.doesNotMatch(usageMaint, /from ['"][^'"]*\/src\/observability\/token-usage-store\.ts/, 'Cron must not use old maintenance facade');
assert.match(retentionOwner, /export async function maintainUsageStats\(/, 'Operations must implement usage maintenance');
assert.match(retentionOwner, /aggregation failed; retention cleanup deferred/, 'Failed aggregation must never discard source rows');
assert.match(retentionOwner, /await flushUsageBuffer\(/, 'Maintenance must flush pending usage before aggregating');
assert.ok(
  retentionCompat.includes("from '../../../operations/maintenance/retention.ts'"),
  'Legacy retention path must re-export the Operations implementation',
);
assert.doesNotMatch(retentionCompat, /export async function /, 'Legacy retention must not duplicate scheduled cleanup logic');

assert.match(compositionRoot, /import operations from '\.\.\/operations\/index\.ts'/, 'Cloudflare composition must delegate to Operations');
assert.match(compositionRoot, /scheduled: operations\.scheduled/, 'Composition must preserve Cron behavior');
assert.doesNotMatch(compositionRoot, /runUsageMaintenance|maintainUsageStats|async scheduled/, 'Composition must not own maintenance implementation');
const composedRuntimeOnly = compositionRoot
  .replace(/\r\n/g, '\n')
  .replace(/^\s*\/\/[^\n]*(?:\n|$)/gm, '')
  .trim();
assert.equal(
  composedRuntimeOnly,
  [
    "import gateway from '../apps/gateway/index.ts';",
    "import operations from '../operations/index.ts';",
    '',
    'export default {',
    '  fetch: gateway.fetch,',
    '  scheduled: operations.scheduled,',
    '};',
  ].join('\n'),
  'Before the protected Cron handoff, the old composition entry must remain a pure fetch/scheduled facade',
);
for (const [app, shim] of [
  ['apps/gateway/index.ts', 'src/index.ts'],
  ['apps/inference/index.ts', 'src/inference/inference-center-entry.ts'],
  ['apps/generation/index.ts', 'src/generation/generation-center-entry.ts'],
  ['apps/perception/index.ts', 'src/perception/perception-center-entry.ts'],
]) {
  assert.ok(existsSync(join(root, app)), `Missing running app: ${app}`);
  assert.match(readFileSync(join(root, shim), 'utf8'), /apps\//, `Compatibility entrypoint not delegated: ${shim}`);
}
for (const path of [
  'apps/inference/index.ts',
  'apps/generation/index.ts',
  'apps/gateway/transport/inference-client-request.ts',
  'apps/gateway/transport/generation-client-request.ts',
]) {
  const content = readFileSync(join(root, path), 'utf8');
  assert.match(content, /packages\/contracts\/execution\.ts/, `${path} does not use the contract`);
}
assert.match(
  readFileSync(join(root, 'apps/perception/index.ts'), 'utf8'),
  /from '\.\.\/\.\.\/packages\/contracts\/runtime\.ts'/,
  'Perception runtime owner must use the shared runtime type contract',
);
const perceptionApp = readFileSync(join(root, 'apps/perception/index.ts'), 'utf8');
assert.match(
  perceptionApp,
  /from '\.\.\/inference\/execution\.ts'/,
  'Perception must explicitly reuse the audited native executor until extraction',
);
assert.doesNotMatch(
  perceptionApp,
  /from '\.\.\/inference\/(?!execution\.ts)[^']+'/,
  'Perception cannot import other Inference application modules',
);
console.log(`Architecture boundary check passed (${checked} package/app files).`);
