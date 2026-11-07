#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Responses conversion, shared event builder and compatibility contract.
import assert from 'node:assert/strict';
import { parseResponsesRequest as ownedParse } from '../apps/inference/conversion/responses.ts';
import { ResponsesStreamDecoder as OwnedDecoder } from '../apps/inference/conversion/responses-stream.ts';
import { ResponsesEventBuilder as OwnedBuilder } from '../packages/conversion-core/responses-events.ts';
import { parseResponsesRequest as legacyParse } from '../src/conversion/matrix/responses.ts';
import { ResponsesStreamDecoder as LegacyDecoder } from '../src/conversion/matrix/responses-stream.ts';
import { ResponsesEventBuilder as LegacyBuilder } from '../src/protocol/responses/events.ts';

assert.strictEqual(ownedParse, legacyParse, 'Responses object converter identity must survive migration');
assert.strictEqual(OwnedDecoder, LegacyDecoder, 'Responses stream decoder identity must survive migration');
assert.strictEqual(OwnedBuilder, LegacyBuilder, 'Responses event builder must remain a singleton implementation');

const parsed = ownedParse({ model: 'test-model', input: 'hello' });
assert.equal(parsed.request.model, 'test-model');
assert.ok(parsed.request.messages.length > 0);
assert.throws(
  () => ownedParse({ model: 'test-model', input: 'hello', unknown_field: true }),
  /conversion_not_supported/,
  'Responses unknown fields must be rejected',
);
const frame = new OwnedBuilder().response_created({ id: 'resp-test', model: 'test-model' });
assert.match(frame, /event: response.created/);
assert.match(frame, /sequence_number/);

const decoder = new OwnedDecoder();
assert.ok(
  decoder
    .push(JSON.stringify({ type: 'response.created', response: { id: 'resp-test', model: 'test-model' } }))
    .events.some((e) => e.type === 'start'),
);
assert.equal(decoder.push('[DONE]').terminal, true);
console.log('Responses codec, SSE events, schema strictness and compatibility identities passed.');
