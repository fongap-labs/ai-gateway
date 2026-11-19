#!/usr/bin/env node
import assert from 'node:assert/strict';
import { LARGE_BODY_CHARS, releaseLargeRequestBody } from '../apps/gateway/attempt/body-release.ts';
import { handleRequest } from '../apps/gateway/request-handler.ts';
import { requestBodyForAttempt } from '../apps/gateway/transport/request-body-cache.ts';
import { createBodyAdmissionPool } from '../packages/transport/body-admission.ts';
import { BodyAdmissionBudgetError, BodyTooLargeError, readBodyTextWithLimit } from '../packages/transport/http.ts';

const MiB = 1024 * 1024;
const cacheState = {};
let cachedModelReads = 0;
const cachedLargeBody = new Proxy(
  { model: 'cached-model', messages: [] },
  {
    get(target, property, receiver) {
      if (property === 'model') cachedModelReads++;
      return Reflect.get(target, property, receiver);
    },
  },
);
requestBodyForAttempt(cacheState, cachedLargeBody, undefined, 'cached-model', true);
const readsBeforeBodyRelease = cachedModelReads;
const largeAttempt = {
  state: cacheState,
  reqDescriptor: { bodyChars: LARGE_BODY_CHARS + 1 },
  bodyJson: cachedLargeBody,
  rawBody: 'large raw request body',
  conversionContext: { converted: true },
};
releaseLargeRequestBody(largeAttempt);
assert.deepEqual(largeAttempt.bodyJson, {}, 'large committed requests release parsed JSON');
assert.equal(largeAttempt.rawBody, undefined, 'large committed requests release raw text');
assert.equal(largeAttempt.conversionContext, null, 'large committed requests release conversion data');
requestBodyForAttempt(cacheState, cachedLargeBody, undefined, 'cached-model', true);
assert.ok(cachedModelReads > readsBeforeBodyRelease, 'large committed requests release cached serialized-body variants');
const oversizedGatewayResponse = await handleRequest(
  new Request('https://gateway.invalid/v1/chat/completions', {
    method: 'POST',
    headers: {
      [String.fromCharCode(97, 117, 116, 104, 111, 114, 105, 122, 97, 116, 105, 111, 110)]: String.fromCharCode(66, 101, 97, 114, 101, 114, 32, 120),
      'content-type': 'application/json',
      'content-length': String(32 * MiB + 1),
    },
    body: '{}',
  }),
  { AIG_ACCESS_KEY_AIR: 'x', AIG_ACCESS_MODELS_AIR: '*' },
  { waitUntil() {} },
);
assert.equal(oversizedGatewayResponse.status, 413, 'a single oversized request gets a permanent 413, not retryable pool-busy 503');
assert.equal(oversizedGatewayResponse.headers.get('retry-after'), null, 'permanent size failures do not ask clients to retry');
const smallAttempt = {
  reqDescriptor: { bodyChars: LARGE_BODY_CHARS },
  bodyJson: { messages: ['retryable'] },
  rawBody: 'small raw request body',
  conversionContext: { converted: false },
};
releaseLargeRequestBody(smallAttempt);
assert.deepEqual(smallAttempt.bodyJson, { messages: ['retryable'] }, 'small requests retain parsed data for retries');
assert.equal(smallAttempt.rawBody, 'small raw request body');
assert.deepEqual(smallAttempt.conversionContext, { converted: false });
const pool = createBodyAdmissionPool();
const first = pool.admitGrowing(0, true);
const second = pool.admitGrowing(0, true);
assert.ok(first && second, 'two unknown-length requests must not both reserve the old 20 MB worst case');
assert.equal(first.observe(12 * MiB), true);
assert.equal(second.observe(14 * MiB), true);
assert.equal(second.observe(22 * MiB), false, 'simultaneous large requests must respect the 32 MB budget');
first.release();
assert.equal(second.observe(20 * MiB), true, 'released memory can be reused without re-admission');
second.release();
second.release();

const liar = pool.admitGrowing(1024, true);
assert.ok(liar, 'known length remains supported');
assert.equal(liar.observe(21 * MiB), true, 'reported length cannot bypass actual-byte charging');
const sibling = pool.admitGrowing(10 * MiB, true);
assert.ok(sibling);
assert.equal(sibling.observe(12 * MiB), false, 'under-declared bodies may not exceed shared memory budget');
liar.release();
sibling.release();

const declared = pool.admitGrowing(20 * MiB, true);
assert.ok(declared);
assert.equal(pool.admitGrowing(20 * MiB, true), null, 'declared large requests remain protected');
declared.release();
assert.equal(pool.admit(32 * MiB + 1, 0), null, 'a single declared body cannot exceed the aggregate budget');
assert.equal(pool.admitGrowing(32 * MiB + 1, true), null, 'a single growing-body reservation cannot exceed the aggregate budget');
const oversizedChunked = pool.admitGrowing(0, true);
assert.ok(oversizedChunked);
assert.equal(oversizedChunked.observe(32 * MiB + 1), false, 'a single growing body cannot exceed the aggregate budget');
oversizedChunked.release();

const chunked = pool.admitGrowing(0, true);
assert.ok(chunked);
const largeText = 'a'.repeat(900_000);
const request = new Request('https://gateway.invalid/v1/messages', {
  method: 'POST',
  body: largeText,
  headers: { 'content-type': 'application/json' },
});
request.headers.delete('content-length');
const decoded = await readBodyTextWithLimit(request, 2 * MiB, chunked.observe);
assert.equal(decoded, largeText);
chunked.release();

const occupied = pool.admitGrowing(18 * MiB, true);
assert.ok(occupied);
const growing = pool.admitGrowing(0, true);
assert.ok(growing);
const tooLarge = new Request('https://gateway.invalid/v1/messages', { method: 'POST', body: 'x'.repeat(16 * MiB) });
tooLarge.headers.delete('content-length');
await assert.rejects(readBodyTextWithLimit(tooLarge, 20 * MiB, growing.observe), BodyAdmissionBudgetError);
occupied.release();
growing.release();

const capped = pool.admitGrowing(0, true);
assert.ok(capped);
const payload = new Request('https://gateway.invalid/v1/messages', { method: 'POST', body: 'y'.repeat(900_000) });
payload.headers.delete('content-length');
await assert.rejects(readBodyTextWithLimit(payload, 512 * 1024, capped.observe), BodyTooLargeError);
capped.release();

const emojiBytes = new TextEncoder().encode('甲🎯乙');
let cursor = 0;
const split = new ReadableStream({
  pull(controller) {
    if (cursor >= emojiBytes.length) return controller.close();
    controller.enqueue(emojiBytes.subarray(cursor, cursor + 1));
    cursor++;
  },
});
const utf8 = new Request('https://gateway.invalid/v1/messages', { method: 'POST', body: split, duplex: 'half' });
const utf8Budget = pool.admitGrowing(0, true);
assert.ok(utf8Budget);
assert.equal(await readBodyTextWithLimit(utf8, 1024, utf8Budget.observe), '甲🎯乙');
utf8Budget.release();

console.log(
  'Measured admission passed: unknown-length concurrency, growth rejection, under-declared sizes, large Code bodies, cap, UTF-8 and release.',
);
