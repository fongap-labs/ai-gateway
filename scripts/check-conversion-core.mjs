#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Runtime identity and compatibility for the provider-neutral conversion core.
import assert from 'node:assert/strict';
import { protocolForSurface } from '../packages/conversion-core/surface-protocol.ts';

// The physical Inference and Perception executors must share one neutral surface map.
for (const [surface, expected] of [
  ['chat_completions', 'openai_chat'],
  ['responses', 'openai_responses'],
  ['messages', 'anthropic'],
  ['images_generations', null],
  ['unknown', null],
]) {
  assert.equal(protocolForSurface(surface), expected, `Execution surface map mismatch: ${surface}`);
}

for (const unit of ['ir', 'budget', 'diag', 'result', 'validation']) {
  const packageModule = await import(`../packages/conversion-core/${unit}.ts`);
  const oldPath = ['ir', 'budget', 'diag'].includes(unit) ? `../src/conversion/matrix/${unit}.ts` : `../src/conversion/${unit}.ts`;
  const compatibilityModule = await import(oldPath);
  assert.deepEqual(Object.keys(compatibilityModule).sort(), Object.keys(packageModule).sort(), `Export inventory drift: ${unit}`);
  for (const name of Object.keys(packageModule)) {
    assert.equal(compatibilityModule[name], packageModule[name], `Duplicate implementation: ${unit}.${name}`);
  }
}

// Matrix translations must remain reference-identical across the neutral owner,
// the Inference compatibility facade, and the historical src API.
for (const unit of [
  'anthropic-stream',
  'anthropic',
  'chat-stream',
  'chat',
  'framed-stream',
  'request',
  'response',
  'responses-stream',
  'responses',
  'stream',
]) {
  const canonical = await import(`../packages/conversion-core/matrix/${unit}.ts`);
  const facade = await import(`../apps/inference/conversion/${unit}.ts`);
  assert.deepEqual(Object.keys(facade).sort(), Object.keys(canonical).sort(), `Matrix facade export drift: ${unit}`);
  for (const name of Object.keys(canonical)) {
    assert.equal(facade[name], canonical[name], `Matrix implementation identity drift: ${unit}.${name}`);
  }
}

// No stale src implementation is allowed to diverge from the shared config,
// HTTP transport or protocol owners. Keep singleton caches and Error classes identical.
for (const [legacy, canonical] of [
  ['src/config/env.ts', 'packages/config-core/env.ts'],
  ['src/config/models.ts', 'packages/config-core/models.ts'],
  ['src/config/nodes.ts', 'packages/config-core/nodes.ts'],
  ['src/config/policies.ts', 'packages/config-core/policies.ts'],
  ['src/config/protocol-fallbacks.ts', 'packages/config-core/protocol-fallbacks.ts'],
  ['src/config/registry.ts', 'packages/config-core/registry.ts'],
  ['src/config/runtime-vars.ts', 'packages/config-core/runtime-vars.ts'],
  ['src/config/timeouts.ts', 'packages/config-core/timeouts.ts'],
  ['src/protocol/anthropic.ts', 'packages/protocol-core/anthropic.ts'],
  ['src/protocol/http.ts', 'packages/transport/http.ts'],
  ['src/protocol/openai.ts', 'packages/protocol-core/openai.ts'],
  ['src/transport/index.ts', 'packages/transport/provider-routing.ts'],
  ['src/types/upstream-processing.ts', 'packages/contracts/upstream-processing.ts'],
  ['src/utils/trim.ts', 'packages/config-core/trim.ts'],
]) {
  const oldOwner = await import(`../${legacy}`);
  const newOwner = await import(`../${canonical}`);
  assert.deepEqual(Object.keys(oldOwner).sort(), Object.keys(newOwner).sort(), `Shared export set drift: ${legacy}`);
  for (const key of Object.keys(newOwner)) {
    assert.equal(oldOwner[key], newOwner[key], `Shared runtime identity drift: ${legacy}.${key}`);
  }
}
const providerRegistry = await import('../src/providers/registry.ts');
const usageContract = await import('../packages/contracts/provider-usage.ts');
assert.equal(providerRegistry.streamUsageEnabled, usageContract.streamUsageEnabled);
for (const provider of ['openai', 'google', 'anthropic', 'unknown-provider']) {
  const node = { provider, protocol: 'openai', surfaces: ['chat_completions'] };
  assert.equal(providerRegistry.streamUsageEnabled(node), usageContract.streamUsageEnabled(node));
  assert.equal(providerRegistry.streamUsageEnabled(node, { AIG_USAGE_INCLUDE_MODE: 'off' }), false);
}

const { ConversionError, parseToolArguments } = await import('../packages/conversion-core/validation.ts');
const { MatrixDiag } = await import('../packages/conversion-core/diag.ts');
const { createMatrixBudget, ConversionBudgetStop } = await import('../packages/conversion-core/budget.ts');
const oldError = (await import('../src/conversion/validation.ts')).ConversionError;
const oldBudgetError = (await import('../src/conversion/matrix/budget.ts')).ConversionBudgetStop;

assert.equal(ConversionError, oldError);
assert.equal(ConversionBudgetStop, oldBudgetError);
assert.deepEqual(parseToolArguments('{"answer":42}'), { answer: 42 });
assert.throws(() => parseToolArguments('not JSON'), ConversionError);

const diag = new MatrixDiag();
assert.equal(diag.fidelity(), 'exact');
diag.add({ feature: 'tool_choice', action: 'mapped' });
assert.equal(diag.fidelity(), 'portable');
diag.add({ feature: 'tool_choice', action: 'dropped' });
assert.equal(diag.fidelity(), 'degraded');

const budget = createMatrixBudget({
  maxEvents: 1,
  maxOutputUnits: 10,
  maxToolEvents: 1,
  maxToolArgUnits: 10,
  maxOutputTokens: 0,
});
assert.ok(budget);
assert.equal(budget.chargeOutput(5), true);
assert.equal(budget.chargeOutput(6), false);
assert.equal(budget.stopped, 'output_units');
console.log('Independent conversion core identity, compatibility and budget contracts passed.');
