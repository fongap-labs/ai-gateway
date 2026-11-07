// SPDX-License-Identifier: MIT

// Copyright (c) 2026 Fongap Labs
//
// Translation-matrix pipeline: the per-protocol adapters (chat / anthropic /
// responses and their streams) are the leaves; this module is the routing hub.
//
// Every directed pair among the three protocols travels through the IR here.
// The legacy pairwise converters that once served Chat <-> Anthropic were
// absorbed: the matrix adapters now cover their semantics (same defaults,
// same rejection contract), so there is a single decode/encode path for every
// gateway translation.

import {
  replyFromNativeObject,
  replyToAnthropicObject,
  replyToChatObject,
  replyToObject,
  replyToResponsesObject,
} from '../../../apps/inference/conversion/response.ts';
import { ResponsesEventBuilder } from '../../protocol/responses/events.ts';
import { markSyntheticClientStreamHeaders } from '../../stream/client-lifecycle.ts';
import { createSseScanner, readWithDeadline } from '../../stream/guard.ts';
import type { ConversionDiagnostic } from '../result.ts';
import { convertSseStream } from '../sse.ts';
import { ConversionError } from '../validation.ts';
import { AnthropicStreamDecoder, AnthropicStreamEncoder } from './anthropic-stream.ts';
import { type BudgetStopReason, ConversionBudgetStop, createMatrixBudget, type MatrixConversionBudget, outputUnitsOf } from './budget.ts';
import { ChatStreamDecoder, ChatStreamEncoder } from './chat-stream.ts';
import { IrCollector, type IrEvent, type IrPart, type IrProtocol, type IrReply, isRecord } from './ir.ts';
import { ResponsesStreamDecoder, ResponsesStreamEncoder } from './responses-stream.ts';

export { convertMatrixRequest, isMatrixPair } from '../../../apps/inference/conversion/request.ts';
export { replyFromNativeObject, replyToAnthropicObject, replyToChatObject, replyToObject, replyToResponsesObject };
export { ConversionError };

// ---- Stream translation ------------------------------------------------------

export type MatrixStreamHandle = {
  clientStream: ReadableStream<Uint8Array>;
  collector: IrCollector;
  from: IrProtocol;
  to: IrProtocol;
  /** Non-null once the upstream reached its terminal event. */
  replyIfDone: () => IrReply | null;
  diagnostics: () => readonly ConversionDiagnostic[];
  /** The budget stop reason once the AIG_CONVERSION_BUDGET expired, else null. */
  budgetExceeded: () => BudgetStopReason | null;
};

/** Wiring for AIG_CONVERSION_BUDGET on the streaming translate path. */
export type MatrixStreamBudget = {
  cfg: MatrixConversionBudget;
  /**
   * AIG_CONVERSION_BUDGET_MODE. "truncate" renders a well-formed short reply
   * (canonical length stop through the collector, then encoder.finish); "error"
   * enqueues `stopChunk` (the client-protocol gateway error frames the success
   * layer built) and closes.
   */
  mode: 'error' | 'truncate';
  stopChunk: Uint8Array | null;
};

/**
 * Wrap a streaming upstream body (the forced `stream:true` request body) into
 * the client protocol stream. Upstream decode and client encode both run
 * through IR; the collector keeps the final reply for usage normalization and
 * the object fallback.
 */
export function openMatrixStream(
  upstreamBody: ReadableStream<Uint8Array> | null | undefined,
  from: IrProtocol,
  to: IrProtocol,
  fallbackId: string,
  options: { onUpstreamUsage?: (usage: unknown) => void; seedInputTokens?: number; model?: string; budget?: MatrixStreamBudget } = {},
): MatrixStreamHandle {
  const collector = new IrCollector();
  const decoder = makeDecoder(from);
  const encoder = makeEncoder(to);
  const textEncoder = new TextEncoder();
  let finalReply: IrReply | null = null;
  const budget = createMatrixBudget(options.budget?.cfg ?? null);
  let budgetStop: BudgetStopReason | null = null;

  // Shared budget-stop choreography. Runs INSIDE convertSseStream's onData, so
  // it must never throw: enqueue the terminal frames, flip the driver's
  // terminal flag and let the driver close cleanly (cancelling the upstream in
  // its finally block). Throwing here would error the client controller — the
  // ungraceful path AIG_CONVERSION_BUDGET_MODE=error deliberately avoids.
  const stopByBudget = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    budgetStop = budget?.stopped ?? null;
    if (options.budget?.mode === 'truncate') {
      // A well-formed shortened reply: the canonical length stop renders the
      // provider-idiomatic terminal frames (finish_reason length /
      // stop_reason max_tokens / response.incomplete) through encoder.finish.
      collector.feed({ type: 'stop', stop: 'length' });
      sealReply(controller);
      return;
    }
    if (options.budget?.stopChunk instanceof Uint8Array && options.budget.stopChunk.byteLength > 0) {
      controller.enqueue(options.budget.stopChunk);
      return;
    }
    // Defensive default when the success layer supplied no error chunk: keep
    // the client stream structured rather than erroring the controller.
    enqueue(controller, textEncoder, [
      'data: {"error":{"message":"Gateway conversion output budget exceeded.","type":"api_error","code":"conversion_budget_exceeded"}}\n\n',
      'data: [DONE]\n\n',
    ]);
  };

  const onData = (data: string, controller: ReadableStreamDefaultController<Uint8Array>): void => {
    const { events, terminal } = pushDecoder(decoder, from, data);
    for (const event of events) {
      if (event.type === 'error') {
        // Throwing unwinds into convertSseStream and errors the client
        // controller, which the outer request boundary treats like any
        // other upstream failure (failover when nothing was written yet).
        throw upstreamReportedError(event.message);
      }
      if (event.type === 'usage') options.onUpstreamUsage?.(event.raw);
      // A caller-known input count fills in when the upstream start event carries none.
      const seeded =
        event.type === 'start' && event.inputTokens === undefined && options.seedInputTokens !== undefined
          ? { ...event, inputTokens: options.seedInputTokens }
          : event;
      const stamped = seeded.type === 'start' && options.model ? { ...seeded, model: options.model } : seeded;
      // Budget probe BEFORE the collector/encoder consume the event, so the
      // overshooting piece is never delivered or billed as translated work.
      if (budget) {
        if (!budget.beginEvent(event) || !budget.chargeOutput(outputUnitsOf(event))) {
          stopByBudget(controller);
          return;
        }
      }
      collector.feed(stamped);
      enqueue(controller, textEncoder, encoder.write(stamped));
    }
    if (terminal) sealReply(controller);
  };

  const sealReply = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (finalReply) return;
    finalReply = collector.finish(fallbackId);
    enqueue(controller, textEncoder, encoder.finish(finalReply));
  };

  // A Chat upstream that closes right after its finish chunk (no usage chunk, no
  // `[DONE]`) still delivered a complete reply; seal it instead of erroring the client.
  const clientStream = convertSseStream(
    upstreamBody,
    onData,
    // The driver stops reading (and cancels the upstream) once the decoder saw
    // its terminal sentinel OR the translation budget expired.
    () => decoder.done || budgetStop !== null,
    (controller) => {
      if (!endsCleanly(decoder)) return false;
      sealReply(controller);
      return true;
    },
  );
  return {
    clientStream,
    collector,
    from,
    to,
    replyIfDone: () => finalReply,
    diagnostics: () => streamDiagnostics(finalReply, to),
    budgetExceeded: () => budgetStop,
  };
}

function upstreamReportedError(message: string): Error {
  // Upstream detail is not echoed to the client; the fallback log keeps the request id.
  void message;
  return new Error('Upstream stream error');
}

function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, textEncoder: TextEncoder, chunks: string[]): void {
  for (const chunk of chunks) {
    if (chunk) controller.enqueue(textEncoder.encode(chunk));
  }
}

function makeDecoder(from: IrProtocol): ChatStreamDecoder | AnthropicStreamDecoder | ResponsesStreamDecoder {
  switch (from) {
    case 'openai_chat':
      return new ChatStreamDecoder();
    case 'anthropic':
      return new AnthropicStreamDecoder();
    case 'openai_responses':
      return new ResponsesStreamDecoder();
    default:
      throw new ConversionError(`conversion_not_supported: matrix decoder "${String(from)}"`);
  }
}

type MatrixStreamEncoder = { write(event: IrEvent): string[]; finish(reply: IrReply): string[] };

function makeEncoder(to: IrProtocol): MatrixStreamEncoder {
  switch (to) {
    case 'openai_chat':
      return new ChatStreamEncoder();
    case 'anthropic':
      return new AnthropicStreamEncoder();
    case 'openai_responses':
      return new ResponsesStreamEncoder();
    default:
      throw new ConversionError(`conversion_not_supported: matrix encoder "${String(to)}"`);
  }
}

function pushDecoder(
  decoder: ChatStreamDecoder | AnthropicStreamDecoder | ResponsesStreamDecoder,
  from: IrProtocol,
  data: string,
): { events: IrEvent[]; terminal: boolean } {
  // The chat decoder owns [DONE] so its terminal flag (read by the SSE driver) is set.
  if (decoder instanceof ChatStreamDecoder) return decoder.push(data);
  if (data === '[DONE]') return { events: [], terminal: true };
  if (from === 'anthropic') {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error('Malformed upstream SSE JSON');
    }
    if (decoder instanceof AnthropicStreamDecoder) return decoder.push(payload);
    return { events: [], terminal: false };
  }
  if (decoder instanceof ResponsesStreamDecoder) return decoder.push(data);
  return { events: [], terminal: false };
}

/** A close without the terminal sentinel is complete only for a Chat reply that already finished. */
function endsCleanly(decoder: ChatStreamDecoder | AnthropicStreamDecoder | ResponsesStreamDecoder): boolean {
  return decoder instanceof ChatStreamDecoder && decoder.finishedReply;
}

function streamDiagnostics(reply: IrReply | null, to: IrProtocol): readonly ConversionDiagnostic[] {
  const diagnostics: ConversionDiagnostic[] = [];
  const sealed = reply?.parts.some((part) => part.type === 'thinking' && part.sealed) ?? false;
  if (sealed && to === 'anthropic') diagnostics.push({ feature: 'thinking_history', action: 'mapped' });
  if (sealed && to !== 'anthropic') diagnostics.push({ feature: 'thinking_history', action: 'dropped' });
  return diagnostics;
}

// ---- Object fallback (non-streaming client over a forced-stream upstream) ----

export async function collectMatrixObject(
  upstreamBody: ReadableStream<Uint8Array> | null | undefined,
  from: IrProtocol,
  to: IrProtocol,
  fallbackId: string,
  clientSignal?: AbortSignal | null,
  deadlineMs?: number | null,
  options: {
    seedInputTokens?: number;
    onUpstreamUsage?: (raw: unknown) => void;
    model?: string;
    budget?: { cfg: MatrixConversionBudget; mode: 'error' | 'truncate' };
  } = {},
): Promise<{ reply: IrReply; object: Record<string, unknown>; diagnostics: readonly ConversionDiagnostic[] }> {
  if (!upstreamBody) throw new Error('Upstream response has no body.');
  const collector = new IrCollector();
  const decoder = makeDecoder(from);
  const budget = createMatrixBudget(options.budget?.cfg ?? null);
  // Anthropic-only seed: mirrors the legacy conversion path's input-token
  // estimate so node accounting does not collapse to zero when message_start
  // carries no usage. A real start event overwrites the seed.
  if (from === 'anthropic' && (options.seedInputTokens ?? 0) > 0) {
    collector.feed({ type: 'start', id: '', model: options.model ?? '', inputTokens: options.seedInputTokens });
  }
  let hasTerminal = false;

  const scanner = createSseScanner((data) => {
    const { events, terminal } = pushDecoder(decoder, from, data);
    for (const event of events) {
      if (event.type === 'error') throw new Error(`upstream stream error: ${event.message || 'unknown'}`);
      if (event.type === 'usage') options.onUpstreamUsage?.(event.raw);
      // AIG_CONVERSION_BUDGET probe BEFORE the collector consumes the event, so
      // the overshooting piece is never rendered or billed as translated work.
      // "error" mode throws ConversionBudgetStop (the success layer renders a
      // 502 and stops; regenerating on another node would bill the same
      // oversized answer). "truncate" seals the canonical length stop and
      // terminates the READ: hasTerminal breaks the read loop, which cancels
      // the upstream, and the collected short reply is rendered normally and
      // delivered with regular success accounting.
      if (budget) {
        if (!budget.beginEvent(event) || !budget.chargeOutput(outputUnitsOf(event))) {
          if (options.budget?.mode === 'truncate') {
            collector.feed({ type: 'stop', stop: 'length' });
            hasTerminal = true;
            return;
          }
          throw new ConversionBudgetStop(budget.stopped as BudgetStopReason);
        }
      }
      const stamped = event.type === 'start' && options.model ? { ...event, model: options.model } : event;
      collector.feed(stamped);
    }
    if (terminal) hasTerminal = true;
  });

  const reader = upstreamBody.getReader();
  const textDecoder = new TextDecoder();
  try {
    for (;;) {
      if (clientSignal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException('Client aborted during stream assembly.', 'AbortError');
      }
      const { done, value } = await readWithDeadline(reader, deadlineMs, () => {
        throw new Error('Upstream stream deadline exceeded during matrix collection.');
      });
      if (done) break;
      scanner.push(textDecoder.decode(value, { stream: true }));
      if (hasTerminal) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    scanner.flush();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (!hasTerminal && !decoder.done && !endsCleanly(decoder)) throw new Error('Upstream stream interrupted before terminal event.');

  const reply = collector.finish(fallbackId);
  return { reply, object: replyToObject(reply, to), diagnostics: streamDiagnostics(reply, to) };
}

// ---- Synthetic SSE (client asked for a stream over a collected reply) --------

export function synthesizeMatrixStreamFromObject(reply: IrReply, to: IrProtocol): Response {
  const encoded = new TextEncoder();
  const chunks: string[] = [];
  if (to === 'openai_responses') {
    chunks.push(...synthesizeResponsesChunks(reply));
  } else {
    const encoder: MatrixStreamEncoder = to === 'openai_chat' ? new ChatStreamEncoder() : new AnthropicStreamEncoder();
    chunks.push(...encoder.write({ type: 'start', id: reply.id, model: reply.model }));
    for (const part of reply.parts) {
      for (const event of partToEvents(part)) chunks.push(...encoder.write(event));
    }
    chunks.push(...encoder.finish(reply));
  }
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoded.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: markSyntheticClientStreamHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      'x-request-id': reply.id,
    }),
  });
}

function synthesizeResponsesChunks(reply: IrReply): string[] {
  const builder = new ResponsesEventBuilder();
  const object = replyToResponsesObject(reply);
  const chunks: string[] = [builder.response_created({ ...object, status: 'in_progress' })];
  const output = Array.isArray(object.output) ? object.output : [];
  for (let i = 0; i < output.length; i++) {
    const item = isRecord(output[i]) ? output[i] : {};
    const itemId = typeof item.id === 'string' && item.id ? item.id : `item_${i}`;
    chunks.push(builder.output_item_added(i, { ...item, status: 'in_progress' }));
    if (item.type === 'message') {
      const text = firstTextOf(item.content, 'text');
      chunks.push(builder.content_part_added(itemId, i));
      if (text) chunks.push(builder.output_text_delta(itemId, i, text));
      chunks.push(builder.output_text_done(itemId, i, text));
      chunks.push(builder.content_part_done(itemId, i, text));
    } else if (item.type === 'reasoning') {
      const text = firstTextOf(item.summary, 'text');
      if (text) {
        chunks.push(builder.reasoning_text_delta(itemId, i, text));
        chunks.push(builder.reasoning_text_done(itemId, i, text));
      }
    } else if (item.type === 'function_call') {
      const args = typeof item.arguments === 'string' ? item.arguments : '';
      chunks.push(builder.function_call_arguments_delta(itemId, i, args));
      chunks.push(builder.function_call_arguments_done(itemId, i, args));
    }
    chunks.push(builder.output_item_done(i, item));
  }
  chunks.push(object.status === 'incomplete' ? builder.response_incomplete(object) : builder.response_completed(object));
  return chunks;
}

function firstTextOf(container: unknown, field: string): string {
  if (!Array.isArray(container)) return '';
  const head = container.find((entry) => isRecord(entry) && typeof entry[field] === 'string');
  return head && isRecord(head) ? (head[field] as string) : '';
}

function partToEvents(part: IrPart): IrEvent[] {
  switch (part.type) {
    case 'text':
      return part.text ? [{ type: 'text', text: part.text }] : [];
    case 'thinking':
      if (part.sealed) return [{ type: 'sealed', text: part.data || '' }];
      if (!part.text) return [];
      return part.signature
        ? [
            { type: 'think', text: part.text },
            { type: 'sig', signature: part.signature },
          ]
        : [{ type: 'think', text: part.text }];
    case 'tool_call':
      return [
        { type: 'tool_start', id: part.id, name: part.name },
        { type: 'tool_args', args: part.args },
      ];
    default:
      return [];
  }
}
