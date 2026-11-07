#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The single request-conversion implementation handles every directed pair.
import assert from 'node:assert/strict';
import { convertMatrixRequest as ownedConvert, isMatrixPair as ownedPair } from '../apps/inference/conversion/request.ts';
import { convertMatrixRequest as legacyConvert, isMatrixPair as legacyPair } from '../src/conversion/matrix/pipeline.ts';

assert.strictEqual(ownedConvert, legacyConvert, 'compatibility conversion must not be a second implementation');
assert.strictEqual(ownedPair, legacyPair, 'protocol pair semantics must share one function');

const protocols = ['openai_chat', 'openai_responses', 'anthropic'];
for (const from of protocols) {
  for (const to of protocols) {
    assert.equal(ownedPair(from, to), from !== to, `incorrect matrix pair: ${from}->${to}`);
  }
}
assert.equal(ownedPair('unsupported', 'openai_chat'), false);

const chat = { model: 'test-model', stream: false, messages: [{ role: 'user', content: 'hello' }] };
const anthropic = { model: 'test-model', max_tokens: 128, stream: false, messages: [{ role: 'user', content: 'hello' }] };
const responses = { model: 'test-model', input: 'hello', stream: false };
for (const [from, body] of [
  ['openai_chat', chat],
  ['anthropic', anthropic],
  ['openai_responses', responses],
]) {
  for (const to of protocols) {
    if (to === from) continue;
    const converted = ownedConvert(from, to, body);
    assert.ok(converted.body, `missing converted body for ${from}->${to}`);
    assert.equal(converted.body.stream, true, `default upstream streaming changed for ${from}->${to}`);
    assert.ok(Array.isArray(converted.diagnostics));
  }
}
const preferred = ownedConvert('openai_chat', 'anthropic', chat, { isNonstreamPreferred: true });
assert.notEqual(preferred.body.stream, true, 'explicit nonstream preference must be honored');
assert.throws(() => ownedConvert('openai_chat', 'openai_chat', chat), /conversion_not_supported/);
assert.throws(() => ownedConvert('openai_chat', 'anthropic', { ...chat, unexpected: true }), /conversion_not_supported/);
console.log('Single request Matrix implementation passed all six protocol pairs and fail-closed semantics.');
