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
