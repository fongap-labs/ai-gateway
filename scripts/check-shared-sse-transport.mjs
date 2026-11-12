#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SSE transport ownership and Gateway guard compatibility contract.
import assert from 'node:assert/strict';
import { markSyntheticClientStreamHeaders as ownedMarker } from '../packages/transport/client-lifecycle.ts';
import { convertSseStream as ownedRelay } from '../packages/transport/convert-sse.ts';
import {
  readWithDeadline as ownedDeadline,
  FIRST_EVENT_MAX_SSE_LINE as ownedLimit,
  createSseScanner as ownedScanner,
} from '../packages/transport/sse.ts';
import { convertSseStream as legacyRelay } from '../src/conversion/sse.ts';
import { markSyntheticClientStreamHeaders as legacyMarker } from '../src/stream/client-lifecycle.ts';
import {
  readWithDeadline as legacyDeadline,
  FIRST_EVENT_MAX_SSE_LINE as legacyLimit,
  createSseScanner as legacyScanner,
} from '../src/stream/guard.ts';

assert.strictEqual(ownedRelay, legacyRelay);
assert.strictEqual(ownedMarker, legacyMarker);
assert.strictEqual(ownedScanner, legacyScanner);
assert.strictEqual(ownedDeadline, legacyDeadline);
assert.equal(ownedLimit, legacyLimit);
assert.equal(ownedMarker()['x-gateway-internal-synthetic-stream'], '1');

const events = [];
const scanner = ownedScanner((data) => events.push(data));
scanner.push('data: {"delta":');
scanner.push('"hello"}\n\ndata: [DONE]\n\n');
scanner.flush();
assert.deepEqual(events, ['{"delta":"hello"}', '[DONE]']);

const encoder = new TextEncoder();
const source = new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode('data: {"value":"ok"}\n\n'));
    controller.close();
  },
});
let finished = false;
const stream = ownedRelay(
  source,
  (data, controller) => {
    controller.enqueue(encoder.encode(data));
    finished = true;
  },
  () => finished,
);
assert.equal(await new Response(stream).text(), '{"value":"ok"}');

// A slow consumer may leave the output queue full indefinitely. The
// conversion must stop upstream reads until another downstream read occurs.
let upstreamReads = 0;
let cancelledReason = null;
let firstFrameReady;
const firstFrame = new Promise((resolve) => {
  firstFrameReady = resolve;
});
const rapidSource = new ReadableStream(
  {
    pull(controller) {
      upstreamReads++;
      controller.enqueue(encoder.encode(`data: {"backpressure":${upstreamReads}}\n\n`));
      if (upstreamReads === 12) controller.close();
    },
    cancel(reason) {
      cancelledReason = reason;
    },
  },
  { highWaterMark: 0 },
);
const slowRelay = ownedRelay(
  rapidSource,
  (data, controller) => {
    controller.enqueue(encoder.encode(data));
    firstFrameReady();
  },
  () => false,
  () => true,
);
await firstFrame;
for (let i = 0; i < 8; i++) await Promise.resolve();
assert.equal(upstreamReads, 1, 'slow downstream must not cause eager upstream read-ahead');
const slowReader = slowRelay.getReader();
assert.equal(new TextDecoder().decode((await slowReader.read()).value), '{"backpressure":1}');
await slowReader.cancel('client-stopped-reading');
assert.equal(cancelledReason, 'client-stopped-reading', 'downstream cancellation propagates to the upstream source');
// Repeated SSE output of several hundred KiB must be consumed one event at
// a time without the upstream racing ahead when downstream demand is absent.
// Use a zero-prefetch upstream so only the converter's reads are measured.
const pressureFrameCount = 256;
const pressurePayload = 'x'.repeat(2048);
let pressureReads = 0;
let pressureFirstReady;
const pressureFirstEvent = new Promise((resolve) => {
  pressureFirstReady = resolve;
});
const pressureSource = new ReadableStream(
  {
    pull(controller) {
      pressureReads++;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ index: pressureReads, payload: pressurePayload })}\n\n`));
      if (pressureReads === pressureFrameCount) controller.close();
    },
  },
  { highWaterMark: 0 },
);
const pressureRelay = ownedRelay(
  pressureSource,
  (data, controller) => {
    controller.enqueue(encoder.encode(data));
    pressureFirstReady();
  },
  () => false,
  () => true,
);
await pressureFirstEvent;
for (let i = 0; i < 8; i++) await Promise.resolve();
assert.equal(pressureReads, 1, 'hundreds of queued SSE frames must not be read while output is idle');
const pressureReader = pressureRelay.getReader();
for (let i = 1; i <= pressureFrameCount; i++) {
  const { done, value } = await pressureReader.read();
  assert.equal(done, false);
  const frame = JSON.parse(new TextDecoder().decode(value));
  assert.equal(frame.index, i, 'backpressured stream preserves every event and its order');
  assert.equal(frame.payload, pressurePayload);
  assert.ok(pressureReads <= i + 1, 'the converter may read at most one frame ahead of consumer demand');
}
assert.equal((await pressureReader.read()).done, true, 'the accepted upstream EOF closes the output');
assert.equal(pressureReads, pressureFrameCount);

// A single Provider chunk can contain multiple SSE messages; the conversion
// must preserve them all. Backpressure applies to subsequent reader.read()
// calls, not to events already present in a chunk.
const batchCount = 32;
const batchedFrames = Array.from({ length: batchCount }, (_, i) => `data: ${JSON.stringify({ index: i + 1 })}\n\n`).join('');
const batchSource = new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode(batchedFrames));
    controller.close();
  },
});
const batchRelay = ownedRelay(
  batchSource,
  (data, controller) => controller.enqueue(encoder.encode(`${data}\n`)),
  () => false,
  () => true,
);
const deliveredBatch = (await new Response(batchRelay).text())
  .trim()
  .split('\n')
  .map((v) => JSON.parse(v).index);
assert.deepEqual(
  deliveredBatch,
  Array.from({ length: batchCount }, (_, i) => i + 1),
);

// Verify UTF-8 continuation bytes split across Provider chunks are decoded
// once, and the SSE size guard still rejects a single oversized data line.
const unicodeEvent = `data: ${JSON.stringify({ value: 'hello 🌟 中文' })}\n\n`;
const unicodeBytes = encoder.encode(unicodeEvent);
const starBytes = encoder.encode('🌟');
const starIndex = unicodeBytes.findIndex((byte, i) => starBytes.every((b, j) => unicodeBytes[i + j] === b));
assert.ok(starIndex > 0);
const unicodeSource = new ReadableStream({
  start(controller) {
    controller.enqueue(unicodeBytes.slice(0, starIndex + 2));
    controller.enqueue(unicodeBytes.slice(starIndex + 2));
    controller.close();
  },
});
const unicodeRelay = ownedRelay(
  unicodeSource,
  (data, controller) => controller.enqueue(encoder.encode(data)),
  () => false,
  () => true,
);
assert.deepEqual(JSON.parse(await new Response(unicodeRelay).text()), { value: 'hello 🌟 中文' });

const oversizedSource = new ReadableStream(
  {
    pull(controller) {
      controller.enqueue(encoder.encode(`data: ${'x'.repeat(ownedLimit + 1)}\n\n`));
    },
  },
  { highWaterMark: 0 },
);
const oversizedRelay = ownedRelay(
  oversizedSource,
  (data, controller) => controller.enqueue(encoder.encode(data)),
  () => false,
);
await assert.rejects(
  () => oversizedRelay.getReader().read(),
  (error) => error?.code === 'first_event_sse_line_exceeded',
  'oversized SSE event must fail with the existing explicit size guard',
);

const reader = new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode('x'));
    controller.close();
  },
}).getReader();
assert.equal(
  new TextDecoder().decode(
    (
      await ownedDeadline(reader, null, async () => {
        throw new Error('unexpected timeout');
      })
    ).value,
  ),
  'x',
);
console.log('Shared SSE parser, relay, deadline, synthetic marker and legacy function identity passed.');
