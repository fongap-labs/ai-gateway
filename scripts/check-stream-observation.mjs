#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Local, deterministic regression checks for native streaming paths.
// This does not call a provider, open a socket, or require any secrets.

import assert from 'node:assert/strict';
import { relayStreamResponse, trackStreamResponse } from '../src/stream/track.ts';

const encoder = new TextEncoder();

function chunkedResponse(wire, step = 7) {
  const bytes = encoder.encode(wire);
  let offset = 0;
  return new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(bytes.byteLength, offset + step);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function counters() {
  const record = { success: 0, failure: 0, neutral: 0, attempts: [], deliveries: [] };
  return {
    record,
    onSuccess: () => record.success++,
    onFailure: () => record.failure++,
    onNeutral: () => record.neutral++,
    onAttemptUsage: (usage, outcome) => record.attempts.push({ usage, outcome }),
    onUsage: (usage) => record.deliveries.push(usage),
  };
}

const wires = [
  {
    protocol: 'openai_chat',
    wire:
      'data: {"model":"physical","choices":[{"delta":{"content":"你好"}}]}\n\n' +
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":7}}\n\n' +
      'data: [DONE]\n\n',
    tokens: 'prompt_tokens',
  },
  {
    protocol: 'openai_responses',
    wire:
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":4,"delta":"你好"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":7}}}\n\n',
    tokens: 'input_tokens',
  },
  {
    protocol: 'anthropic',
    wire:
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":3,"output_tokens":7}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    tokens: 'input_tokens',
  },
];

for (const { protocol, wire, tokens } of wires) {
  const callbacks = counters();
  const result = relayStreamResponse(chunkedResponse(wire, 3), {
    protocol,
    idleTimeoutMs: 1000,
    ...callbacks,
  });
  assert.equal(await result.text(), wire, `\${protocol}: must preserve exact SSE bytes`);
  assert.equal(callbacks.record.success, 1, `\${protocol}: successful terminal marker`);
  assert.equal(callbacks.record.failure, 0);
  assert.equal(callbacks.record.attempts.length, 1, `\${protocol}: exactly one physical settlement`);
  assert.equal(callbacks.record.attempts[0].outcome, 'success');
  assert.equal(callbacks.record.deliveries.length, 1);
  assert.equal(callbacks.record.deliveries[0][tokens], 3);
}

// Model rewrite remains on the tracked path and preserves usage accounting.
{
  const wire = wires[0].wire;
  const callbacks = counters();
  const result = trackStreamResponse(chunkedResponse(wire, 5), {
    protocol: 'openai_chat',
    idleTimeoutMs: 1000,
    rewriteModel: 'logical',
    ...callbacks,
  });
  const text = await result.text();
  assert.match(text, /"model":"logical"/);
  assert.doesNotMatch(text, /"model":"physical"/);
  assert.match(text, /data: \[DONE\]/);
  assert.equal(callbacks.record.success, 1);
  assert.equal(callbacks.record.deliveries[0].prompt_tokens, 3);
}

// EOF without a completion marker is not a successful upstream response.
{
  const callbacks = counters();
  const wire = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  const result = relayStreamResponse(chunkedResponse(wire), {
    protocol: 'openai_chat',
    idleTimeoutMs: 1000,
    ...callbacks,
  });
  assert.equal(await result.text(), wire);
  assert.equal(callbacks.record.success, 0);
  assert.equal(callbacks.record.failure, 1);
  assert.equal(callbacks.record.attempts[0].outcome, 'failure');
  assert.equal(callbacks.record.deliveries.length, 0);
}

// An explicit SSE error must never count as delivered usage or success.
{
  const callbacks = counters();
  const wire = 'event: error\ndata: {"type":"error","error":{"message":"upstream failed"}}\n\n';
  const result = relayStreamResponse(chunkedResponse(wire, 2), {
    protocol: 'anthropic',
    idleTimeoutMs: 1000,
    ...callbacks,
  });
  assert.equal(await result.text(), wire);
  assert.equal(callbacks.record.failure, 1);
  assert.equal(callbacks.record.success, 0);
  assert.equal(callbacks.record.attempts[0].outcome, 'failure');
  assert.equal(callbacks.record.deliveries.length, 0);
}

// Only a Responses interruption needs the sequence number of the next event.
{
  let dispatched = false;
  const broken = new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (!dispatched) {
            dispatched = true;
            controller.enqueue(
              encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":6,"delta":"x"}\n\n'),
            );
          } else {
            controller.error(new Error('upstream interrupted'));
          }
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const callbacks = counters();
  const result = trackStreamResponse(broken, {
    protocol: 'openai_responses',
    idleTimeoutMs: 1000,
    interruptionChunk: (_reason, details) => encoder.encode(`event: error\ndata: {"sequence_number":${String(details?.nextSequenceNumber)}}\n\n`),
    ...callbacks,
  });
  const text = await result.text();
  assert.match(text, /"sequence_number":6/);
  assert.match(text, /event: error\ndata: {"sequence_number":7}/);
  assert.equal(callbacks.record.success, 0);
  assert.equal(callbacks.record.failure, 1);
  assert.equal(callbacks.record.attempts[0].outcome, 'failure');
}
console.log('Native SSE relay regression checks passed.');
