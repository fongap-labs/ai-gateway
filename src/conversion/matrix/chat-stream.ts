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
// Mirrors the legacy anthropic-stream-to-openai-chat lifecycle: assistant
// role chunk, delta chunks (`content` / `reasoning_content` / `tool_calls`
// index-scoped), finish chunk with usage rollup, then `[DONE]`.

import { chatStopFromIr, chatStopToIr, chatToolId } from './chat.ts';
import type { IrEvent, IrReply } from './ir.ts';
import { isRecord } from './ir.ts';

type OpenToolCall = { id: string; name: string; started: boolean; index: number };

export class ChatStreamDecoder {
  private started = false;
  private terminal = false;
  private readonly openTools = new Map<string, OpenToolCall>();
  private nextToolIdSeed = 0;

  get done(): boolean {
    return this.terminal;
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
      return { events: [], terminal: false };
    }
    if (!isRecord(payload)) return { events: [], terminal: false };
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
      const key = String(Number.isFinite(call.index) ? call.index : this.nextToolIdSeed + 1);
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
    }
    return { events, terminal: false };
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
        this.id = event.id ? `chatcmpl-${event.id}` : '';
        this.model = event.model;
        this.createdAt = Math.floor(Date.now() / 1000);
        return [this.chunk({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null })];
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
    const chunks: string[] = [this.chunk({ index: 0, delta: {}, finish_reason: chatStopFromIr(reply.stop) })];
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
  return {
    ...raw,
    prompt_tokens: Number.isFinite(raw.input_tokens) ? raw.input_tokens : reply.inputTokens || 0,
    completion_tokens: Number.isFinite(raw.output_tokens) ? raw.output_tokens : 0,
    total_tokens: Number.isFinite(raw.total_tokens) ? raw.total_tokens : (Number(raw.input_tokens) || 0) + (Number(raw.output_tokens) || 0),
  };
}
