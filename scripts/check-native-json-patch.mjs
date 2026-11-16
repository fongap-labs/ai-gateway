#!/usr/bin/env node
import assert from 'node:assert/strict';
import { requestBodyForAttempt } from '../apps/gateway/transport/request-body-cache.ts';
import { withUsageStreamOptions } from '../packages/protocol-core/openai.ts';
import { readBodyTextWithLimit } from '../packages/transport/http.ts';
import { patchNativeJsonTopLevel } from '../packages/transport/native-json-patch.ts';

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
assert.equal(
  patchNativeJsonTopLevel('{"model":"one","model":"Code-Max"}', 'Code-Max', 'physical', false),
  null,
  'duplicate root model must fall back',
);
assert.equal(
  patchNativeJsonTopLevel('{"messages":[],"model":"Code-Max","temperature":1}', 'Code-Max', 'physical', false),
  null,
  'middle model falls back',
);
assert.equal(patchNativeJsonTopLevel(source, 'wrong-client-model', 'physical', false), null, 'model mismatch must not be silently rewritten');

for (const stream_options of [{ include_usage: false }, { include_usage: true, extra: 'keep' }, null, 'odd']) {
  const provided = JSON.stringify({ ...original, stream_options });
  assert.equal(patchNativeJsonTopLevel(provided, 'Code-Max', 'physical', true), null, 'original stream_options semantics must be preserved');
}

const embedded = JSON.stringify({ model: 'Code-Max', messages: [{ content: '{"model":"not-a-real-key"}' }] });
const patchedEmbedded = patchNativeJsonTopLevel(embedded, 'Code-Max', 'physical', false);
assert.equal(JSON.parse(patchedEmbedded).messages[0].content, '{"model":"not-a-real-key"}');
const cacheState = {};
const fallbackBody = { model: 'Code-Max', messages: [{ role: 'user', content: 'safe' }] };
const fallbackRaw = JSON.stringify(fallbackBody);
assert.equal(requestBodyForAttempt(cacheState, fallbackBody, fallbackRaw, 'Code-Max', false), fallbackRaw);
assert.deepEqual(JSON.parse(requestBodyForAttempt(cacheState, fallbackBody, fallbackRaw, 'Code-Pro', false)), { ...fallbackBody, model: 'Code-Pro' });
const ambiguousBody = { messages: [{ model: 'nested' }], model: 'Code-Max' };
const ambiguousRaw = JSON.stringify(ambiguousBody);
assert.deepEqual(JSON.parse(requestBodyForAttempt(cacheState, ambiguousBody, ambiguousRaw, 'Code-Pro', false)), {
  ...ambiguousBody,
  model: 'Code-Pro',
});

const rebuiltState = {};
const rebuiltBody = { model: 'Code-Max', messages: [{ role: 'user', content: 'normalized' }], stream: false };
const stringifyOriginal = JSON.stringify;
let serializations = 0;
try {
  JSON.stringify = (...args) => {
    serializations++;
    return stringifyOriginal(...args);
  };
  const firstSerialized = requestBodyForAttempt(rebuiltState, rebuiltBody, undefined, 'Code-Max', false);
  assert.equal(requestBodyForAttempt(rebuiltState, rebuiltBody, undefined, 'Code-Max', false), firstSerialized);
  assert.equal(serializations, 1, 'same request and model should serialize once across retries');
  const forcedStream = requestBodyForAttempt(rebuiltState, rebuiltBody, undefined, 'Code-Max', true);
  assert.equal(JSON.parse(forcedStream).stream, true);
  assert.equal(requestBodyForAttempt(rebuiltState, rebuiltBody, undefined, 'Code-Max', true), forcedStream);
  assert.equal(serializations, 2, 'stream override should serialize only once');
  const changedModel = requestBodyForAttempt(rebuiltState, rebuiltBody, undefined, 'Code-Pro', false);
  assert.equal(JSON.parse(changedModel).model, 'Code-Pro');
  assert.equal(serializations, 3, 'distinct model mappings must not share serialized bodies');
  const changedBody = { ...rebuiltBody, messages: [{ role: 'user', content: 'new request body' }] };
  assert.equal(JSON.parse(requestBodyForAttempt(rebuiltState, changedBody, undefined, 'Code-Max', false)).messages[0].content, 'new request body');
  assert.equal(serializations, 4, 'changed body invalidates earlier serialized variants');
} finally {
  JSON.stringify = stringifyOriginal;
}
const textFixture = JSON.stringify({ model: 'Code-Max', messages: [{ content: '中文'.repeat(150_000) + 'A'.repeat(1_000_000) }] });
const encodedFixture = new TextEncoder().encode(textFixture);
const chunkSizes = [1, 2, 3, 17, 1_024, 65_537];
function chunkedRequest() {
  return new Request('https://gateway.example/large-body', {
    method: 'POST',
    duplex: 'half',
    body: new ReadableStream({
      start(controller) {
        let position = 0;
        let segment = 0;
        while (position < encodedFixture.byteLength) {
          const next = Math.min(encodedFixture.byteLength, position + chunkSizes[segment++ % chunkSizes.length]);
          controller.enqueue(encodedFixture.subarray(position, next));
          position = next;
        }
        controller.close();
      },
    }),
  });
}
const observedBodySizes = [];
assert.equal(
  await readBodyTextWithLimit(chunkedRequest(), encodedFixture.byteLength, (size) => {
    observedBodySizes.push(size);
    return true;
  }),
  textFixture,
  'incremental UTF-8 decoding must preserve multi-byte boundaries and large JSON payloads',
);
assert.equal(observedBodySizes.at(-1), encodedFixture.byteLength, 'admission must count bytes, not decoded characters');
await assert.rejects(readBodyTextWithLimit(chunkedRequest(), encodedFixture.byteLength - 1), { name: 'BodyTooLargeError' });
await assert.rejects(
  readBodyTextWithLimit(chunkedRequest(), encodedFixture.byteLength, (size) => size < 1_000),
  {
    name: 'BodyAdmissionBudgetError',
  },
);

console.log('Native JSON patch passed: large-body equivalence, raw fallback preservation and request-local serialization reuse.');
