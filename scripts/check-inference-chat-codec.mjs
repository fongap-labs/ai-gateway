#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Native Node contract test: conversion codec ownership and legacy identity.
import assert from 'node:assert/strict';
import { ChatStreamDecoder as OwnedDecoder } from '../apps/inference/conversion/chat-stream.ts';
import { parseChatRequest as ownedParse } from '../apps/inference/conversion/chat.ts';
import { ChatStreamDecoder as LegacyDecoder } from '../src/conversion/matrix/chat-stream.ts';
import { parseChatRequest as legacyParse } from '../src/conversion/matrix/chat.ts';

assert.strictEqual(LegacyDecoder, OwnedDecoder, 'legacy export must preserve class identity');
assert.strictEqual(legacyParse, ownedParse, 'legacy export must preserve parser identity');

const parsed = ownedParse({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] });
assert.equal(typeof parsed.request, 'object');
assert.ok(parsed.diag, 'conversion diagnostics remain available');
assert.throws(
  () => ownedParse({ model: 'test-model', messages: [], unknown_field: true }),
  /conversion_not_supported/,
  'unsupported request fields must still fail closed',
);

const decoder = new OwnedDecoder();
const frame = JSON.stringify({
  id: 'chatcmpl-test',
  object: 'chat.completion.chunk',
  model: 'test-model',
  choices: [{ index: 0, delta: { role: 'assistant', content: 'answer' }, finish_reason: null }],
});
assert.ok(decoder.push(frame).events.some((e) => e.type === 'text' && e.text === 'answer'));
assert.equal(decoder.push('[DONE]').terminal, true);
console.log('Inference Chat codec owner, compatibility identity, strict field checks and SSE decode passed.');
