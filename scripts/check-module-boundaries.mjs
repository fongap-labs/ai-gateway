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
      assert.ok(!target.startsWith('apps/') || target.startsWith(`apps/${ownApp}/`), `${local} imports another app: ${target}`);
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

const dispatchSource = readFileSync(join(root, 'src/request/attempt/dispatch.ts'), 'utf8');
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
  /return dispatchInferenceAttempt\(c, sourceBody\);/,
  'Every inference attempt must route through the private Inference Center',
);
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
const centerDispatch = readFileSync(join(root, 'src/request/attempt/inference-dispatch.ts'), 'utf8');
assert.match(inferenceExecutor, /convertMatrixRequest\(from, to, clientBody/, 'Inference must execute the physical protocol request conversion');
assert.match(inferenceExecutor, /highRiskSemanticLoss\(converted\)/, 'Center must recheck high-risk fidelity');
assert.match(centerDispatch, /c\.conversionContext \? c\.bodyJson : sourceBody/, 'Gateway must send original body for v2 center conversion');
const responseCenter = readFileSync(join(root, 'apps/inference/execution.ts'), 'utf8');
const responseGateway = readFileSync(join(root, 'src/request/attempt/success-matrix.ts'), 'utf8');
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
assert.match(frameConsumer, /unframeInferenceStream\(/, 'Gateway decoder must strip private control frames');
assert.match(
  readFileSync(join(root, 'src/request/attempt/success-matrix.ts'), 'utf8'),
  /apps\/gateway\/transport\/inference-stream-client\.ts/,
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
const inferenceV4Dispatcher = readFileSync(join(root, 'src/request/attempt/inference-dispatch.ts'), 'utf8');
const inferenceV4Success = readFileSync(join(root, 'src/request/attempt/success-matrix.ts'), 'utf8');
assert.match(inferenceV4Contract, /EXECUTION_STREAM_CONTRACT_VERSION = '4'/, 'v4 must have dedicated fail-closed execution contract');
assert.match(inferenceV4Executor, /buildFramedMatrixResponse\(/, 'Inference must execute real private streaming conversion');
assert.match(inferenceV4Contract, /EXECUTION_BUDGET_STREAM_CONTRACT_VERSION = '5'/, 'v5 must isolate budgeted streams from legacy v4');
assert.match(inferenceV4Dispatcher, /returnStream && limits\.conversionBudget/, 'Budgeted center streams must use v5, not local conversion');
assert.match(inferenceV4Success, /decodeFramedInferenceResponse\(/, 'Gateway must strip private frames before commit');
assert.match(inferenceV4Success, /guardProtocol = isFramed \? clientIr : upstreamIr/, 'First event must inspect actual client protocol');
const centerBudget = readFileSync(join(root, 'apps/inference/execution.ts'), 'utf8');
const budgetGateway = readFileSync(join(root, 'src/request/attempt/inference-dispatch.ts'), 'utf8');
const budgetSettlement = readFileSync(join(root, 'src/request/attempt/success-matrix.ts'), 'utf8');
assert.match(centerBudget, /streamFramingOptions\(invocation, to\)/, 'Inference must enforce v5 stream budgets');
assert.match(budgetGateway, /streamBudget,/, 'Gateway must issue bounded v5 budgets');
assert.match(budgetSettlement, /centerBudgetStop = reason/, 'Gateway must observe v5 private stop reasons');
assert.match(budgetSettlement, /budgetExceeded: \(\) => centerBudgetStop/, 'Gateway must settle v5 budget event once');
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
for (const [app, shim] of [
  ['apps/gateway/index.ts', 'src/index.ts'],
  ['apps/inference/index.ts', 'src/inference/inference-center-entry.ts'],
  ['apps/generation/index.ts', 'src/generation/generation-center-entry.ts'],
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
console.log(`Architecture boundary check passed (${checked} package/app files).`);
