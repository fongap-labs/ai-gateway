// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { markSyntheticClientStreamHeaders } from '../../stream/client-lifecycle.ts';
import { createSseScanner, readWithDeadline } from '../../stream/guard.ts';
import { UPSTREAM_PROCESSING_ERROR, type UpstreamProcessingErrorCode, upstreamProcessingError } from '../../types/upstream-processing.ts';
import { ResponsesEventBuilder } from './events.ts';

const MAX_COLLECTED_BYTES = 2 * 1024 * 1024;

export async function collectResponsesObject(
  upstream: Response,
  clientSignal: AbortSignal | null | undefined,
  deadlineMs?: number | null,
): Promise<Record<string, unknown>> {
  if (!upstream.body) throw upstreamProcessingError(UPSTREAM_PROCESSING_ERROR.EMPTY, 'Upstream response has no body.');
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let collected: Record<string, unknown> | null = null;

  const fail = async (code: UpstreamProcessingErrorCode, message: string): Promise<never> => {
    await reader.cancel().catch(() => {});
    throw upstreamProcessingError(code, message);
  };

  let isSemanticEof = false;
  const scanner = createSseScanner((data) => {
    if (!data || data === '[DONE]') return;
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(data) as Record<string, unknown> | null;
    } catch (error) {
      throw upstreamProcessingError(UPSTREAM_PROCESSING_ERROR.MALFORMED, 'Upstream returned malformed streaming data.', error);
    }
    if (json?.type === 'response.failed') {
      const failed = (json.response ?? {}) as { error?: { message?: string } };
      throw upstreamProcessingError(
        UPSTREAM_PROCESSING_ERROR.TERMINAL,
        `Upstream reported response.failed: ${failed.error?.message || 'unknown error'}`,
      );
    }
    if ((json?.type === 'response.completed' || json?.type === 'response.incomplete') && json.response && typeof json.response === 'object') {
      collected = json.response as Record<string, unknown>;
      isSemanticEof = true;
    }
  });

  try {
    for (;;) {
      if (clientSignal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException('Client aborted during stream assembly.', 'AbortError');
      }
      const { done, value } = await readWithDeadline(reader, deadlineMs, (message) => fail(UPSTREAM_PROCESSING_ERROR.DEADLINE, message));
      if (done) break;
      receivedBytes += value.byteLength;
      scanner.push(decoder.decode(value, { stream: true }));
      if (receivedBytes > MAX_COLLECTED_BYTES) {
        await fail(UPSTREAM_PROCESSING_ERROR.TOO_LARGE, 'Assembled response exceeded gateway memory safety limit. Use stream:true.');
      }
      if (isSemanticEof) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    scanner.flush();
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }

  if (!collected) {
    throw upstreamProcessingError(UPSTREAM_PROCESSING_ERROR.TRUNCATED, 'Upstream stream ended before a terminal response event.');
  }
  return collected;
}

export function synthesizeResponsesFromObject(
  response: Record<string, unknown> | null | undefined,
  requestedModel: string,
  extraHeaders?: Record<string, string>,
): Response {
  const events = new ResponsesEventBuilder();
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  const object: Record<string, unknown> = response && typeof response === 'object' ? response : {};
  if (object.model !== undefined) object.model = requestedModel;

  chunks.push(events.response_created({ ...object, status: 'in_progress' }));
  const output = Array.isArray(object.output) ? object.output : [];
  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    const inProgress = { ...item, status: 'in_progress' };
    chunks.push(events.output_item_added(i, inProgress));
    if (item?.type === 'message') {
      const text = item.content?.[0]?.text || '';
      chunks.push(events.content_part_added(item.id, i));
      if (text) chunks.push(events.output_text_delta(item.id, i, text));
      chunks.push(events.output_text_done(item.id, i, text));
      chunks.push(events.content_part_done(item.id, i, text));
    } else if (item?.type === 'reasoning') {
      const text = item.content?.[0]?.text || '';
      if (text) {
        chunks.push(events.reasoning_text_delta(item.id, i, text));
        chunks.push(events.reasoning_text_done(item.id, i, text));
      }
    } else if (item?.type === 'function_call') {
      chunks.push(events.function_call_arguments_delta(item.id, i, item.arguments));
      chunks.push(events.function_call_arguments_done(item.id, i, item.arguments));
    }
    chunks.push(events.output_item_done(i, item));
  }
  chunks.push(object.status === 'incomplete' ? events.response_incomplete(object) : events.response_completed(object));

  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: markSyntheticClientStreamHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      ...(extraHeaders || {}),
    }),
  });
}
