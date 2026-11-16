// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { IrEvent, IrReply } from '../ir.ts';
import { isRecord } from '../ir.ts';
import { chatStopFromIr, chatStopToIr, chatToolId } from './chat.ts';

type OpenToolCall = {
  id: string;
  name: string;
  started: boolean;
  index: number;
  pending: string[];
  upstreamIndex: number | null;
  upstreamId: string;
  syntheticId: boolean;
};

export class ChatStreamDecoder {
  private started = false;
  private terminal = false;
  private finished = false;
  private readonly openTools = new Map<string, OpenToolCall>();
  private readonly indexToKey = new Map<string, string>();
  private readonly idToKey = new Map<string, string>();
  private nextToolIdSeed = 0;
  private lastToolKey: string | null = null;

  get done(): boolean {
    return this.terminal;
  }

  get finishedReply(): boolean {
    return this.finished;
  }

  push(raw: string): { events: IrEvent[]; terminal: boolean } {
    if (this.terminal) return { events: [], terminal: false };
    if (raw === '[DONE]') {
      this.terminal = true;
      const flushed = this.flushDeferredTools();
      return { events: flushed, terminal: true };
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
      const fragmentName = isRecord(call.function) && typeof call.function.name === 'string' ? call.function.name : '';
      let open = this.openTools.get(key);
      if (!open) {
        open = {
          id: typeof call.id === 'string' && call.id ? call.id : chatToolId(call.id),
          name: fragmentName,
          started: false,
          index: this.openTools.size,
          pending: [],
          upstreamIndex: null,
          upstreamId: '',
          syntheticId: !(typeof call.id === 'string' && call.id),
        };
        this.nextToolIdSeed += 1;
        this.openTools.set(key, open);
      }
      if (typeof call.id === 'string' && call.id && !open.upstreamId) {
        open.upstreamId = call.id;
        this.idToKey.set(call.id, key);
        if (open.syntheticId) {
          open.id = call.id;
          open.syntheticId = false;
        }
      }
      if (Number.isFinite(call.index)) {
        const upstreamIndex = Math.trunc(Number(call.index));
        if (open.upstreamIndex === null) {
          open.upstreamIndex = upstreamIndex;
          this.indexToKey.set(String(upstreamIndex), key);
        }
      }
      if (fragmentName && !open.name) {
        open.name = fragmentName;
      }
      const args = isRecord(call.function) && typeof call.function.arguments === 'string' && call.function.arguments ? call.function.arguments : '';
      if (!open.name) {
        if (args) open.pending.push(args);
        continue;
      }
      if (!open.started) events.push(...openToolStartEvents(open));
      if (args) events.push({ type: 'tool_args', args });
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      events.push(...this.flushDeferredTools());
      events.push({ type: 'stop', stop: chatStopToIr(choice.finish_reason) });
      this.finished = true;
      if (isRecord(payload.usage)) this.terminal = true;
      return { events, terminal: this.terminal };
    }
    if (this.finished && isRecord(payload.usage)) {
      this.terminal = true;
      events.push(...this.flushDeferredTools());
      return { events, terminal: true };
    }
    return { events, terminal: false };
  }

  private flushDeferredTools(): IrEvent[] {
    const events: IrEvent[] = [];
    for (const open of this.openTools.values()) {
      if (!open.started) events.push(...openToolStartEvents(open));
    }
    return events;
  }

  private toolKeyOf(call: Record<string, unknown>): string {
    const rawIndex = Number.isFinite(call.index) ? Math.trunc(Number(call.index)) : null;
    const callId = typeof call.id === 'string' && call.id ? call.id : '';
    const indexKey = rawIndex !== null ? String(rawIndex) : '';

    if (indexKey) {
      const mapped = this.indexToKey.get(indexKey);
      if (mapped && this.openTools.has(mapped)) return mapped;
    }
    if (callId) {
      const mapped = this.idToKey.get(callId);
      if (mapped && this.openTools.has(mapped)) return mapped;
    }

    if (indexKey || callId) {
      const candidates = [...this.openTools.entries()].filter(([, open]) =>
        indexKey ? open.upstreamIndex === null && (!callId || !open.upstreamId || open.upstreamId === callId) : !open.upstreamId,
      );
      if (candidates.length === 1) {
        const [key, open] = candidates[0] as [string, OpenToolCall];
        if (indexKey) {
          open.upstreamIndex = rawIndex;
          this.indexToKey.set(indexKey, key);
        }
        if (callId && !open.upstreamId) {
          open.upstreamId = callId;
          this.idToKey.set(callId, key);
        }
        return key;
      }
    }

    if (callId) return `id:${callId}`;
    if (indexKey) return indexKey;
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

function openToolStartEvents(open: OpenToolCall): IrEvent[] {
  open.started = true;
  if (!open.name) open.name = 'tool';
  const events: IrEvent[] = [{ type: 'tool_start', id: open.id, name: open.name }];
  if (open.pending.length) {
    const args = open.pending.join('');
    open.pending.length = 0;
    events.push({ type: 'tool_args', args });
  }
  return events;
}

export function chatUsageFromRaw(reply: IrReply): Record<string, unknown> {
  const raw = isRecord(reply.rawUsage) ? reply.rawUsage : {};
  if (raw.prompt_tokens !== undefined) return raw;
  const promptTokens = typeof raw.input_tokens === 'number' && Number.isFinite(raw.input_tokens) ? raw.input_tokens : reply.inputTokens || 0;
  const completionTokens = typeof raw.output_tokens === 'number' && Number.isFinite(raw.output_tokens) ? raw.output_tokens : 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: typeof raw.total_tokens === 'number' && Number.isFinite(raw.total_tokens) ? raw.total_tokens : promptTokens + completionTokens,
  };
}
