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
for (const file of [...walk(join(root, 'packages')), ...walk(join(root, 'apps'))]) {
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
  }
  checked++;
}
assert.ok(checked >= 4, 'Missing independently owned app entrypoints or contracts');
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

const imagePreflight = readFileSync(join(root, 'apps/gateway/preflight.ts'), 'utf8');
const imageExecutor = readFileSync(join(root, 'apps/generation/execution.ts'), 'utf8');
assert.doesNotMatch(imagePreflight, /getProviderAdapter/, 'Gateway preflight must not execute Provider image adapters');
assert.match(imagePreflight, /canRouteImageGeneration/, 'Gateway must use the shared image capability declaration');
assert.match(imageExecutor, /isImageGenerationProvider/, 'Generation Center must enforce the same Provider capability declaration');

const dispatchSource = readFileSync(join(root, 'src/request/attempt/dispatch.ts'), 'utf8');
const legacySource = readFileSync(join(root, 'src/request/attempt/legacy-provider-dispatch.ts'), 'utf8');
assert.doesNotMatch(
  dispatchSource,
  /await fetch\(|resolveSubscriptionCredential|getProviderAdapter|buildUpstreamHeadersFor/,
  'Gateway dispatch selector must not perform Provider execution or OAuth',
);
assert.match(dispatchSource, /dispatchLegacyProvider\(c, sourceBody\)/, 'Old direct transport must have one explicit seam');
assert.match(legacySource, /export async function dispatchLegacyProvider\(/, 'Legacy transport must be isolated for later deletion');
assert.match(legacySource, /await fetch\(/, 'Legacy outbound request must stay behind its seam');
assert.doesNotMatch(legacySource, /runTierLoop|dispatchWithHedge/, 'Legacy transport must not own request-level scheduling');
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
  matrixPipelineCompat.includes("export { convertMatrixRequest, isMatrixPair } from '../../../apps/inference/conversion/request.ts';"),
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

const gatewaySource = readFileSync(join(root, 'apps/gateway/index.ts'), 'utf8');
assert.doesNotMatch(gatewaySource, /maintainUsageStats|async scheduled/, 'Gateway app must not own scheduled D1 maintenance');
assert.match(
  readFileSync(join(root, 'src/index.ts'), 'utf8'),
  /operations\/maintenance\/usage\.ts/,
  'Cloudflare composition must retain scheduled maintenance',
);
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
  'src/inference/inference-client-request.ts',
  'src/generation/generation-client-request.ts',
]) {
  const content = readFileSync(join(root, path), 'utf8');
  assert.match(content, /packages\/contracts\/execution\.ts/, `${path} does not use the contract`);
}
console.log(`Architecture boundary check passed (${checked} package/app files).`);
