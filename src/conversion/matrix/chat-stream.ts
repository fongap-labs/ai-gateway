// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// OpenAI Chat Completions streaming side of the translation matrix.
//
// ChatStreamDecoder: upstream Chat SSE data payloads -> IR events. Terminal is
// the literal `[DONE]` sentinel. Multi-choice replies are collapsed to the
// first choice (the gateway drives single-turn agent traffic).
//
// ChatStreamEncoder: IR events -> Chat completion chunks for a Chat client.
// Assistant role chunk, delta chunks (`content` / `reasoning_content` /
// `tool_calls` index-scoped), finish chunk with usage rollup, then `[DONE]`.

import { chatStopFromIr, chatStopToIr, chatToolId } from './chat.ts';
import type { IrEvent, IrReply } from './ir.ts';
import { isRecord } from './ir.ts';

type OpenToolCall = { id: string; name: string; started: boolean; index: number };

export class ChatStreamDecoder {
  private started = false;
  private terminal = false;
  private finished = false;
  private readonly openTools = new Map<string, OpenToolCall>();
  private nextToolIdSeed = 0;
  private lastToolKey: string | null = null;

  get done(): boolean {
    return this.terminal;
  }

  /**
   * True once a `finish_reason` was seen. Providers differ on what follows it:
   * a usage-only chunk and `[DONE]` (OpenAI), or a plain close with no sentinel.
   * A close after the finish is therefore a complete reply, not an interruption.
   */
  get finishedReply(): boolean {
    return this.finished;
  }

  push(raw: string): { events: IrEvent[]; terminal: boolean } {
    if (this.terminal) return { events: [], terminal: false };
    if (raw === '[DONE]') {
      this.terminal = true;
      return { events: [], terminal: true };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error('Malformed upstream SSE JSON');
    }
    if (!isRecord(payload)) return { events: [], terminal: false };
    if (payload.type === 'error' || isRecord(payload.error)) {
      const err = isRecord(payload.error) ? payload.error : {};
      return { events: [{ type: 'error', message: typeof err.message === 'string' ? err.message : '' }], terminal: true };
    }
    const events: IrEvent[] = [];
    if (!this.started) {
      this.started = true;
      events.push({
        type: 'start',
        id: typeof payload.id === 'string' ? payload.id : '',
        model: typeof payload.model === 'string' ? payload.model : '',
      });
    }
    if (isRecord(payload.usage)) events.push({ type: 'usage', raw: payload.usage });
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : {};
    const delta = isRecord(choice.delta) ? choice.delta : {};
    if (typeof delta.content === 'string' && delta.content) events.push({ type: 'text', text: delta.content });
    const reasoning =
      typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (reasoning) events.push({ type: 'think', text: reasoning });

    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isRecord(call)) continue;
      const key = this.toolKeyOf(call);
      this.lastToolKey = key;
      let open = this.openTools.get(key);
      if (!open) {
        open = {
          id: typeof call.id === 'string' && call.id ? call.id : chatToolId(call.id),
          name: isRecord(call.function) && typeof call.function.name === 'string' ? call.function.name : '',
          started: false,
          index: this.openTools.size,
        };
        this.nextToolIdSeed += 1;
        this.openTools.set(key, open);
      }
      if (!open.started) {
        open.started = true;
        if (isRecord(call.function) && typeof call.function.name === 'string' && call.function.name) open.name = call.function.name;
        if (!open.id && !open.name) open.name = 'tool';
        events.push({ type: 'tool_start', id: open.id, name: open.name });
      } else if (isRecord(call.function) && typeof call.function.name === 'string' && call.function.name && !open.name) {
        open.name = call.function.name;
      }
      if (isRecord(call.function) && typeof call.function.arguments === 'string' && call.function.arguments) {
        events.push({ type: 'tool_args', args: call.function.arguments });
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      events.push({ type: 'stop', stop: chatStopToIr(choice.finish_reason) });
      this.finished = true;
      // Usage normally rides on a later chunk with empty choices (include_usage), so the
      // reply is only sealed here when this chunk already carries it; otherwise the
      // trailing usage chunk or `[DONE]` seals it.
      if (isRecord(payload.usage)) this.terminal = true;
      return { events, terminal: this.terminal };
    }
    // After the finish, the first usage-bearing chunk completes the reply.
    if (this.finished && isRecord(payload.usage)) {
      this.terminal = true;
      return { events, terminal: true };
    }
    return { events, terminal: false };
  }

  // Upstreams identify a call across fragments in different ways: an index, a repeated id,
  // or nothing at all for an argument continuation. Without an index an id names the call,
  // and a bare fragment continues the most recent one.
  private toolKeyOf(call: Record<string, unknown>): string {
    if (Number.isFinite(call.index)) return String(call.index);
    if (typeof call.id === 'string' && call.id) return `id:${call.id}`;
    return this.lastToolKey ?? String(this.nextToolIdSeed + 1);
  }
}

export class ChatStreamEncoder {
  private started = false;
  private id = '';
  private model = '';
  private createdAt = 0;
  private toolIndex = -1;

  write(event: IrEvent): string[] {
    switch (event.type) {
      case 'start': {
        this.started = true;
        // Upstream ids pass through unchanged, as the OpenAI Chat client expects.
        this.id = event.id;
        this.model = event.model;
        this.createdAt = Math.floor(Date.now() / 1000);
        return [this.chunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null })];
      }
      case 'think':
        if (!this.ensureStarted()) return [];
        return [this.chunk({ index: 0, delta: { reasoning_content: event.text }, finish_reason: null })];
      case 'text':
        if (!this.ensureStarted()) return [];
        return [this.chunk({ index: 0, delta: { content: event.text }, finish_reason: null })];
      case 'tool_start': {
        if (!this.ensureStarted()) return [];
        this.toolIndex += 1;
        const out = this.deltas([
          this.toolCallDelta(this.toolIndex, { id: event.id, type: 'function', function: { name: event.name, arguments: '' } }),
        ]);
        return out;
      }
      case 'tool_args':
        if (this.toolIndex < 0) return [];
        return this.deltas([this.toolCallDelta(this.toolIndex, { function: { arguments: event.args } })]);
      case 'stop':
      case 'usage':
        return [];
      default:
        return [];
    }
  }

  finish(reply: IrReply): string[] {
    const raw = isRecord(reply.rawUsage) ? reply.rawUsage : {};
    const promptTokens =
      typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : typeof raw.input_tokens === 'number' ? raw.input_tokens : reply.inputTokens;
    const completionTokens =
      typeof raw.completion_tokens === 'number' ? raw.completion_tokens : typeof raw.output_tokens === 'number' ? raw.output_tokens : 0;
    const prompt = Number.isFinite(promptTokens) ? promptTokens : 0;
    const completion = Number.isFinite(completionTokens) ? completionTokens : 0;
    // Wire order matches OpenAI: finish_reason chunk, then the usage-only chunk, then [DONE].
    const chunks = [this.chunk({ index: 0, delta: {}, finish_reason: chatStopFromIr(reply.stop) })];
    if (prompt > 0 || completion > 0) {
      chunks.push(this.usageChunk({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }));
    }
    chunks.push('data: [DONE]\n\n');
    return chunks;
  }

  private ensureStarted(): boolean {
    if (this.started) return true;
    this.started = true;
    this.id = this.id || 'chatcmpl-translated';
    this.createdAt = Math.floor(Date.now() / 1000);
    return true;
  }

  /** Usage rides on a root-level chunk with no choices, as the OpenAI stream defines it. */
  private usageChunk(usage: Record<string, unknown>): string {
    return `data: ${JSON.stringify({
      id: this.id || 'chatcmpl-translated',
      object: 'chat.completion.chunk',
      created: this.createdAt,
      model: this.model,
      choices: [],
      usage,
    })}\n\n`;
  }

  private chunk(choiceDelta: Record<string, unknown>): string {
    return `data: ${JSON.stringify({
      id: this.id || 'chatcmpl-translated',
      object: 'chat.completion.chunk',
      created: this.createdAt,
      model: this.model,
      choices: [choiceDelta],
    })}\n\n`;
  }

  private deltas(toolCalls: Record<string, unknown>[]): string[] {
    return [
      `data: ${JSON.stringify({
        id: this.id || 'chatcmpl-translated',
        object: 'chat.completion.chunk',
        created: this.createdAt,
        model: this.model,
        choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
      })}\n\n`,
    ];
  }

  private toolCallDelta(index: number, fields: Record<string, unknown>): Record<string, unknown> {
    return { index, ...fields };
  }
}

/** Recast usage between Chat naming (prompt/completion) and Responses naming (input/output). */
export function chatUsageFromRaw(reply: IrReply): Record<string, unknown> {
  const raw = isRecord(reply.rawUsage) ? reply.rawUsage : {};
  if (raw.prompt_tokens !== undefined) return raw;
  // Client-facing usage carries only the three Chat counters; cache and other
  // provider fields reach per-attempt accounting through the upstream usage hook.
  return {
    prompt_tokens: Number.isFinite(raw.input_tokens) ? raw.input_tokens : reply.inputTokens || 0,
    completion_tokens: Number.isFinite(raw.output_tokens) ? raw.output_tokens : 0,
    total_tokens: Number.isFinite(raw.total_tokens) ? raw.total_tokens : (Number(raw.input_tokens) || 0) + (Number(raw.output_tokens) || 0),
  };
}
