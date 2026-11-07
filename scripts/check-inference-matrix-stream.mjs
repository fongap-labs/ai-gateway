#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Matrix stream owner, SSE transformation and compatibility identity.
import assert from 'node:assert/strict';
import {
  collectMatrixObject as ownedCollect,
  openMatrixStream as ownedStream,
  synthesizeMatrixStreamFromObject as ownedSynthesize,
} from '../apps/inference/conversion/stream.ts';
import {
  collectMatrixObject as oldCollect,
  openMatrixStream as oldStream,
  synthesizeMatrixStreamFromObject as oldSynthesize,
} from '../src/conversion/matrix/pipeline.ts';

assert.strictEqual(oldCollect, ownedCollect);
assert.strictEqual(oldStream, ownedStream);
assert.strictEqual(oldSynthesize, ownedSynthesize);

const encoder = new TextEncoder();
const frames = [
  {
    id: 'cmpl-stream',
    object: 'chat.completion.chunk',
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
  },
  { id: 'cmpl-stream', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
].map((part) => `data: ${JSON.stringify(part)}\n\n`);
frames.push('data: [DONE]\n\n');
const lines = frames.join('');
function body() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}
const streamed = ownedStream(body(), 'openai_chat', 'anthropic', 'reply-fallback', { model: 'test-model' });
const output = await new Response(streamed.clientStream).text();
assert.match(output, /hello/);
assert.ok(streamed.replyIfDone(), 'IR collector must seal on upstream terminal event');
assert.equal(streamed.budgetExceeded(), null);

const assembled = await ownedCollect(body(), 'openai_chat', 'openai_responses', 'reply-fallback');
assert.equal(assembled.object.output[0].content[0].text, 'hello');

const synthetic = ownedSynthesize(assembled.reply, 'openai_responses');
assert.match(synthetic.headers.get('content-type') ?? '', /text\/event-stream/);
assert.match(await synthetic.text(), /response\.completed/);
console.log('Inference Matrix SSE owner, compatibility identity, stream collection and synthetic events passed.');
