#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// A v4 transport proof: center SSE conversion + private usage/budget framing.
import assert from 'node:assert/strict';
import { buildFramedMatrixResponse } from '../apps/inference/conversion/framed-stream.ts';
import {
  encodeInferenceFrame,
  frameInferenceStream,
  INFERENCE_FRAMED_STREAM_CONTENT_TYPE,
  INFERENCE_FRAMED_STREAM_FORMAT,
  unframeInferenceStream,
} from '../packages/contracts/inference-stream-frames.ts';
import { decodeFramedInferenceResponse } from '../apps/gateway/transport/inference-stream-client.ts';

const encoder = new TextEncoder();
function source(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
function fromChunks(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}
const data = [
  {
    id: 'cmpl-framed',
    object: 'chat.completion.chunk',
    model: 'model-test',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
  },
  {
    id: 'cmpl-framed',
    object: 'chat.completion.chunk',
    model: 'model-test',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
  {
    id: 'cmpl-framed',
    object: 'chat.completion.chunk',
    model: 'model-test',
    choices: [],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, upstream_private_tag: 'private-only' },
  },
];
const providerSse = `${data.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('')}data: [DONE]\n\n`;
const center = buildFramedMatrixResponse(source(encoder.encode(providerSse)), 'openai_chat', 'anthropic', 'framed-id', { model: 'model-test' });
assert.equal(center.headers.get('content-type'), INFERENCE_FRAMED_STREAM_CONTENT_TYPE);
assert.equal(center.headers.get('x-aig-response-format'), INFERENCE_FRAMED_STREAM_FORMAT);

const rawUsage = [];
const publicStream = decodeFramedInferenceResponse(center, { onUsage: (usage) => rawUsage.push(usage) });
const publicBody = await new Response(publicStream).text();
assert.match(publicBody, /hello/);
assert.match(publicBody, /message_stop/);
assert.doesNotMatch(publicBody, /upstream_private_tag|private-only/);
assert.deepEqual(rawUsage, [data[2].usage]);

const sample = encoder.encode('event: test\ndata: unicode € 中文\n\n');
const encoded = frameInferenceStream(
  (notifyUsage) => {
    notifyUsage({ total_tokens: 7, debug: 'never-public' });
    return source(sample);
  },
  () => 'output_units',
);
const privateBytes = new Uint8Array(await new Response(encoded).arrayBuffer());
const segments = [];
for (let i = 0; i < privateBytes.byteLength; i += 3) segments.push(privateBytes.slice(i, i + 3));
const usage = [];
const stopped = [];
const reconstructed = unframeInferenceStream(fromChunks(segments), {
  onUsage: (value) => usage.push(value),
  onBudgetStop: (reason) => stopped.push(reason),
});
assert.equal(await new Response(reconstructed).text(), new TextDecoder().decode(sample));
assert.deepEqual(usage, [{ total_tokens: 7, debug: 'never-public' }]);
assert.deepEqual(stopped, ['output_units']);

const noPublicHeader = new Response(source(encoder.encode('data: hi\n\n')), { headers: { 'content-type': 'text/event-stream' } });
assert.throws(() => decodeFramedInferenceResponse(noPublicHeader), /invalid private inference stream response/);
async function rejectBytes(parts) {
  await assert.rejects(new Response(unframeInferenceStream(fromChunks(parts))).text(), /invalid private inference stream frame/);
}
const done = encodeInferenceFrame({ kind: 'done' });
const chunk = encodeInferenceFrame({ kind: 'chunk', bytes: encoder.encode('data: ok\n\n') });
await rejectBytes([chunk]); // missing done, never a silently successful stream
await rejectBytes([done, chunk]); // data after the terminal marker
await rejectBytes([new Uint8Array([0xa7, 0x02, 0x01, 0, 0, 0, 0])]); // version downgrade
await rejectBytes([new Uint8Array([0xa7, 0x01, 0x01, 0, 1, 0, 1])]); // oversized advertised payload
await rejectBytes([encodeInferenceFrame({ kind: 'budget', reason: 'events' }), encodeInferenceFrame({ kind: 'budget', reason: 'events' }), done]);

let wasCancelled = false;
const cancellable = frameInferenceStream(
  () =>
    new ReadableStream({
      pull(controller) {
        controller.enqueue(encoder.encode('data: still-going\n\n'));
      },
      cancel() {
        wasCancelled = true;
      },
    }),
);
const reader = unframeInferenceStream(cancellable).getReader();
assert.equal((await reader.read()).done, false);
await reader.cancel('client abort');
assert.equal(wasCancelled, true, 'public reader cancellation must reach private provider stream');
console.log('Private framed SSE contract: conversion, usage isolation, budgets, fragmentation, strict terminal and cancellation passed.');
