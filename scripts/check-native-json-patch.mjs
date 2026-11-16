#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Deterministic large native-body rewrite safety and equivalence contracts.
import assert from 'node:assert/strict';
import { patchNativeJsonTopLevel } from '../packages/transport/native-json-patch.ts';
import { withUsageStreamOptions } from '../packages/protocol-core/openai.ts';

const original = {
  model: 'Code-Max',
  stream: true,
  messages: [{ role: 'user', content: '给出结果：' + 'A'.repeat(1_200_000) }],
  tools: [{ type: 'function', function: { name: 'do_work', parameters: { type: 'object', properties: { code: { type: 'string' } } } } }],
};
const source = JSON.stringify(original);
const rewritten = patchNativeJsonTopLevel(source, 'Code-Max', 'physical-provider-model', true);
assert.ok(rewritten, 'large request must use the fast path');
assert.deepEqual(JSON.parse(rewritten), withUsageStreamOptions({ ...original, model: 'physical-provider-model' }));
assert.equal(patchNativeJsonTopLevel(source, 'Code-Max', 'Code-Max', false), source, 'identity mapping is byte-preserving');

const endModel = JSON.stringify({ stream: true, messages: [{ content: '你好' }], model: 'Code-Max' });
const atEnd = patchNativeJsonTopLevel(endModel, 'Code-Max', 'physical', false);
assert.equal(JSON.parse(atEnd).model, 'physical');
assert.equal(JSON.parse(atEnd).messages[0].content, '你好');
const nestedFirst = JSON.stringify({ messages: [{ model: 'nested' }], stream: true, model: 'Code-Max' });
assert.equal(patchNativeJsonTopLevel(nestedFirst, 'Code-Max', 'physical', false), null, 'ambiguous nested model must fall back');
assert.equal(patchNativeJsonTopLevel('{"model":"one","model":"Code-Max"}', 'Code-Max', 'physical', false), null, 'duplicate root model must fall back');
assert.equal(patchNativeJsonTopLevel('{"messages":[],"model":"Code-Max","temperature":1}', 'Code-Max', 'physical', false), null, 'middle model falls back');
assert.equal(patchNativeJsonTopLevel(source, 'wrong-client-model', 'physical', false), null, 'model mismatch must not be silently rewritten');

for (const stream_options of [{ include_usage: false }, { include_usage: true, extra: 'keep' }, null, 'odd']) {
  const provided = JSON.stringify({ ...original, stream_options });
  assert.equal(patchNativeJsonTopLevel(provided, 'Code-Max', 'physical', true), null, 'original stream_options semantics must be preserved');
}

const embedded = JSON.stringify({ model: 'Code-Max', messages: [{ content: '{"model":"not-a-real-key"}' }] });
const patchedEmbedded = patchNativeJsonTopLevel(embedded, 'Code-Max', 'physical', false);
assert.equal(JSON.parse(patchedEmbedded).messages[0].content, '{"model":"not-a-real-key"}');
console.log('Native JSON patch passed: large-body equivalence and conservative fallback.');
