#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Anthropic converter compatibility and streaming contracts without providers.
import assert from 'node:assert/strict';
import { parseAnthropicRequest as ownedParse } from '../apps/inference/conversion/anthropic.ts';
import { AnthropicStreamDecoder as OwnedDecoder } from '../apps/inference/conversion/anthropic-stream.ts';
import { parseAnthropicRequest as legacyParse } from '../src/conversion/matrix/anthropic.ts';
import { AnthropicStreamDecoder as LegacyDecoder } from '../src/conversion/matrix/anthropic-stream.ts';

assert.strictEqual(legacyParse, ownedParse, 'compatibility parser must keep reference identity');
assert.strictEqual(LegacyDecoder, OwnedDecoder, 'compatibility decoder must keep class identity');

const parsed = ownedParse({ model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] });
assert.equal(parsed.request.model, 'claude-test');
assert.ok(parsed.diag);
assert.throws(
  () => ownedParse({ model: 'claude-test', max_tokens: 0, messages: [] }),
  /conversion_not_supported/,
  'invalid max_tokens must be rejected',
);
const decoder = new OwnedDecoder();
assert.deepEqual(decoder.push({ type: 'ping' }).events, []);
assert.equal(decoder.push({ type: 'message_stop' }).terminal, true);
console.log('Inference Anthropic codec ownership, compatibility, field validation and SSE lifecycle passed.');
