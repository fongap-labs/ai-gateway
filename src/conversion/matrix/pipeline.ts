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

import { ResponsesEventBuilder } from '../../protocol/responses/events.ts';
import { markSyntheticClientStreamHeaders } from '../../stream/client-lifecycle.ts';
import { createSseScanner, readWithDeadline } from '../../stream/guard.ts';
import type { ConversionDiagnostic, ConversionResult, StructuredOutputStrategy } from '../result.ts';
import { convertSseStream } from '../sse.ts';
import { ConversionError } from '../validation.ts';
import { anthropicObjectToIr, anthropicStopFromIr, buildAnthropicRequest, parseAnthropicRequest } from './anthropic.ts';
import { AnthropicStreamDecoder, AnthropicStreamEncoder } from './anthropic-stream.ts';
import { buildChatRequest, chatObjectToIr, chatStopFromIr, chatToolId, parseChatRequest } from './chat.ts';
import { ChatStreamDecoder, ChatStreamEncoder, chatUsageFromRaw } from './chat-stream.ts';
import { MatrixDiag } from './diag.ts';
import { IrCollector, type IrEvent, type IrPart, type IrProtocol, type IrReply, type IrRequest, isRecord } from './ir.ts';
import { buildResponsesRequest, parseResponsesRequest, responsesObjectToIr } from './responses.ts';
import { ResponsesStreamDecoder, ResponsesStreamEncoder } from './responses-stream.ts';

export { ConversionError };

const MATRIX_PROTOCOLS: readonly IrProtocol[] = ['openai_chat', 'openai_responses', 'anthropic'];

/** True for every directed pair the matrix owns (all distinct protocol pairs). */
export function isMatrixPair(from: IrProtocol, to: IrProtocol): boolean {
  if (from === to) return false;
  if (!MATRIX_PROTOCOLS.includes(from) || !MATRIX_PROTOCOLS.includes(to)) return false;
  return true;
}

// ---- Request translation ----------------------------------------------------

export function convertMatrixRequest(from: IrProtocol, to: IrProtocol, body: Record<string, unknown>): ConversionResult {
  if (!isMatrixPair(from, to)) throw new ConversionError(`conversion_not_supported: pair ${String(from)}->${String(to)} is not matrix-owned`);
  let ir: IrRequest;
  let diag: MatrixDiag;
  switch (from) {
    case 'openai_chat':
      ({ request: ir, diag } = parseChatRequest(body));
      break;
    case 'anthropic':
      ({ request: ir, diag } = parseAnthropicRequest(body));
      break;
    case 'openai_responses':
      ({ request: ir, diag } = parseResponsesRequest(body));
      break;
    default:
      throw new ConversionError(`conversion_not_supported: pair ${String(from)}->${String(to)}`);
  }
  return buildTarget(to, ir, diag);
}

function buildTarget(to: IrProtocol, ir: IrRequest, diag: MatrixDiag): ConversionResult {
  switch (to) {
    case 'anthropic':
      return finalizeMatrix(diag, buildAnthropicRequest(ir, diag), ir.structuredOutputSchema ? 'prompt' : undefined);
    case 'openai_chat':
      return finalizeMatrix(diag, buildChatRequest(ir, diag), ir.structuredOutputSchema ? 'prompt' : undefined);
    case 'openai_responses':
      return finalizeMatrix(diag, buildResponsesRequest(ir, diag), ir.structuredOutputSchema ? 'native' : undefined);
    default:
      throw new ConversionError(`conversion_not_supported: matrix target "${String(to)}"`);
  }
}

function finalizeMatrix(diag: MatrixDiag, body: Record<string, unknown>, structuredOutput: StructuredOutputStrategy | undefined): ConversionResult {
  // Matrix paths always drive the upstream in streaming mode; non-streaming
  // clients are served from the collected reply (single decode path).
  body.stream = true;
  return diag.finalize(body, structuredOutput ? { strategy: structuredOutput } : undefined);
}

// ---- Stream translation ------------------------------------------------------

export type MatrixStreamHandle = {
  clientStream: ReadableStream<Uint8Array>;
  collector: IrCollector;
  from: IrProtocol;
  to: IrProtocol;
  /** Non-null once the upstream reached its terminal event. */
  replyIfDone: () => IrReply | null;
  diagnostics: () => readonly ConversionDiagnostic[];
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
  options: { onUpstreamUsage?: (usage: unknown) => void; seedInputTokens?: number } = {},
): MatrixStreamHandle {
  const collector = new IrCollector();
  const decoder = makeDecoder(from);
  const encoder = makeEncoder(to);
  const textEncoder = new TextEncoder();
  let finalReply: IrReply | null = null;

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
      collector.feed(seeded);
      enqueue(controller, textEncoder, encoder.write(seeded));
    }
    if (terminal && !finalReply) {
      finalReply = collector.finish(fallbackId);
      enqueue(controller, textEncoder, encoder.finish(finalReply));
    }
  };

  const clientStream = convertSseStream(upstreamBody, onData, () => decoder.done);
  return { clientStream, collector, from, to, replyIfDone: () => finalReply, diagnostics: () => streamDiagnostics(finalReply, to) };
}

function upstreamReportedError(message: string): Error {
  // Upstream detail is not echoed to the client; the fallback log keeps the request id.
  void message;
  return new Error('Upstream stream error');
}

// ---- Native object -> IR (>providers that ignore stream:true) ----------------

export function replyFromNativeObject(
  from: IrProtocol,
  data: Record<string, unknown>,
): {
  reply: IrReply;
  diagnostics: readonly ConversionDiagnostic[];
} {
  const diag = new MatrixDiag();
  const reply =
    from === 'anthropic' ? anthropicObjectToIr(data).reply : from === 'openai_chat' ? chatObjectToIr(data).reply : responsesObjectToIr(data).reply;
  return { reply, diagnostics: diag.diagnostics };
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
  options: { seedInputTokens?: number; onUpstreamUsage?: (raw: unknown) => void } = {},
): Promise<{ reply: IrReply; object: Record<string, unknown>; diagnostics: readonly ConversionDiagnostic[] }> {
  if (!upstreamBody) throw new Error('Upstream response has no body.');
  const collector = new IrCollector();
  const decoder = makeDecoder(from);
  // Anthropic-only seed: mirrors the legacy conversion path's input-token
  // estimate so node accounting does not collapse to zero when message_start
  // carries no usage. A real start event overwrites the seed.
  if (from === 'anthropic' && (options.seedInputTokens ?? 0) > 0) {
    collector.feed({ type: 'start', id: '', model: '', inputTokens: options.seedInputTokens });
  }
  let hasTerminal = false;

  const scanner = createSseScanner((data) => {
    const { events, terminal } = pushDecoder(decoder, from, data);
    for (const event of events) {
      if (event.type === 'error') throw new Error(`upstream stream error: ${event.message || 'unknown'}`);
      if (event.type === 'usage') options.onUpstreamUsage?.(event.raw);
      collector.feed(event);
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
  if (!hasTerminal && !decoder.done) throw new Error('Upstream stream interrupted before terminal event.');

  const reply = collector.finish(fallbackId);
  return { reply, object: replyToObject(reply, to), diagnostics: streamDiagnostics(reply, to) };
}

// ---- Reply rendering (object path) ------------------------------------------

export function replyToObject(reply: IrReply, to: IrProtocol): Record<string, unknown> {
  switch (to) {
    case 'openai_chat':
      return replyToChatObject(reply);
    case 'anthropic':
      return replyToAnthropicObject(reply);
    case 'openai_responses':
      return replyToResponsesObject(reply);
    default:
      throw new ConversionError(`conversion_not_supported: matrix render "${String(to)}"`);
  }
}

export function replyToChatObject(reply: IrReply): Record<string, unknown> {
  let content = '';
  const reasoning: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const part of reply.parts) {
    if (part.type === 'text') content += part.text;
    else if (part.type === 'thinking') {
      if (part.text) reasoning.push(part.text);
      // Sealed (redacted) blocks have no Chat representation: dropped.
    } else if (part.type === 'tool_call') {
      toolCalls.push({ id: part.id || chatToolId(part.id), type: 'function', function: { name: part.name, arguments: part.args } });
    }
  }
  const message: Record<string, unknown> = { role: 'assistant', content };
  if (reasoning.length) message.reasoning_content = reasoning.join('');
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: reply.id || 'chatcmpl-translated',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: reply.model,
    choices: [{ index: 0, message, finish_reason: chatStopFromIr(reply.stop) }],
    usage: chatUsageFromRaw(reply),
  };
}

export function replyToAnthropicObject(reply: IrReply): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  for (const part of reply.parts) {
    if (part.type === 'text') {
      if (part.text) content.push({ type: 'text', text: part.text });
    } else if (part.type === 'thinking') {
      if (part.sealed && part.data) content.push({ type: 'redacted_thinking', data: part.data });
      else if (part.text) content.push({ type: 'thinking', thinking: part.text, ...(part.signature ? { signature: part.signature } : {}) });
    } else if (part.type === 'tool_call') {
      let input: unknown = {};
      try {
        input = JSON.parse(part.args || '{}');
      } catch {
        input = { raw: part.args };
      }
      content.push({ type: 'tool_use', id: part.id || chatToolId(part.id), name: part.name, input: isRecord(input) ? input : {} });
    }
  }
  const raw = isRecord(reply.rawUsage) ? reply.rawUsage : {};
  return {
    id: reply.id || 'msg_translated',
    type: 'message',
    role: 'assistant',
    model: reply.model,
    content,
    stop_reason: anthropicStopFromIr(reply.stop),
    stop_sequence: null,
    usage: {
      input_tokens: firstFinite(raw.input_tokens, raw.prompt_tokens) ?? reply.inputTokens ?? 0,
      output_tokens: firstFinite(raw.output_tokens, raw.completion_tokens) ?? 0,
    },
  };
}

export function replyToResponsesObject(reply: IrReply): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  let open: { type: 'text' | 'think'; id: string; text: string } | null = null;
  let itemSeed = 0;
  const flushOpen = (): void => {
    if (!open) return;
    if (open.type === 'text') {
      output.push({
        type: 'message',
        id: open.id,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: open.text, annotations: [] }],
      });
    } else {
      output.push({ type: 'reasoning', id: open.id, summary: open.text ? [{ type: 'summary_text', text: open.text }] : [] });
    }
    open = null;
  };
  for (const part of reply.parts) {
    if (part.type === 'text') {
      if (!part.text) continue;
      if (open?.type !== 'text') {
        flushOpen();
        open = { type: 'text', id: `msg_${itemSeed++}`, text: '' };
      }
      open.text += part.text;
    } else if (part.type === 'thinking') {
      if (part.sealed) {
        flushOpen();
        output.push({ type: 'reasoning', id: `rs_${itemSeed++}`, encrypted_content: part.data || '' });
      } else if (part.text) {
        flushOpen();
        open = { type: 'think', id: `rs_${itemSeed++}`, text: part.text };
      }
    } else if (part.type === 'tool_call') {
      flushOpen();
      output.push({
        type: 'function_call',
        id: `fc_${itemSeed++}`,
        call_id: part.id || chatToolId(part.id),
        name: part.name,
        arguments: part.args,
        status: 'completed',
      });
    }
  }
  flushOpen();
  const status = reply.stop === 'length' ? 'incomplete' : 'completed';
  const raw = isRecord(reply.rawUsage) ? reply.rawUsage : {};
  const input = firstFinite(raw.input_tokens, raw.prompt_tokens) ?? reply.inputTokens ?? 0;
  const outputTokens = firstFinite(raw.output_tokens, raw.completion_tokens) ?? 0;
  return {
    id: reply.id || 'resp_translated',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: reply.model,
    output,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    usage: { input_tokens: input, output_tokens: outputTokens, total_tokens: input + outputTokens },
  };
}

function firstFinite(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (Number.isFinite(value)) return value as number;
  }
  return undefined;
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
