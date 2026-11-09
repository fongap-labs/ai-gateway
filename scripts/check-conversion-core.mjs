#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Runtime identity and compatibility for the provider-neutral conversion core.
import assert from 'node:assert/strict';

for (const unit of ['ir', 'budget', 'diag', 'result', 'validation']) {
  const packageModule = await import(`../packages/conversion-core/${unit}.ts`);
  const oldPath = ['ir', 'budget', 'diag'].includes(unit) ? `../src/conversion/matrix/${unit}.ts` : `../src/conversion/${unit}.ts`;
  const compatibilityModule = await import(oldPath);
  assert.deepEqual(Object.keys(compatibilityModule).sort(), Object.keys(packageModule).sort(), `Export inventory drift: ${unit}`);
  for (const name of Object.keys(packageModule)) {
    assert.equal(compatibilityModule[name], packageModule[name], `Duplicate implementation: ${unit}.${name}`);
  }
}

const { isMatrixPair } = await import('../packages/conversion-core/protocol-pairs.ts');
const { isMatrixPair: inferencePair } = await import('../apps/inference/conversion/request.ts');
const { isMatrixPair: compatibilityPair } = await import('../src/conversion/matrix/pipeline.ts');
assert.equal(isMatrixPair, inferencePair, 'Inference must reuse the pure protocol-pair predicate');
assert.equal(isMatrixPair, compatibilityPair, 'Legacy exports must retain function identity');
for (const from of ['openai_chat', 'openai_responses', 'anthropic']) {
  for (const to of ['openai_chat', 'openai_responses', 'anthropic']) {
    assert.equal(isMatrixPair(from, to), from !== to, `Matrix pair ${from} -> ${to}`);
  }
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
