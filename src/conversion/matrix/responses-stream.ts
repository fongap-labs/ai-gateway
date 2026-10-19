// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// OpenAI Responses streaming side of the translation matrix.
//
// ResponsesStreamDecoder: upstream Responses SSE data payloads -> IR events.
// Terminal is response.completed / response.incomplete / response.failed
// (or a literal `[DONE]` sentinel; native Responses streams do not send one,
// but tolerate it). Item state is tracked by output_index / item_id.
//
// ResponsesStreamEncoder: IR events -> Responses SSE for a Responses client,
// reusing ResponsesEventBuilder so framing (sequence_number, event names,
// shapes) stays byte-compatible with the native path.

import { ResponsesEventBuilder } from '../../protocol/responses/events.ts';
import type { IrEvent, IrReply, IrStop } from './ir.ts';
import { isRecord } from './ir.ts';

type OpenItem = { type: 'text' | 'think' | 'tool' | 'other'; itemId: string; streamed: boolean };

function responsesUsageFromRaw(reply: IrReply): Record<string, unknown> {
  const raw = isRecord(reply.rawUsage) ? reply.rawUsage : {};
  const input = firstFinite(raw.input_tokens, raw.prompt_tokens) ?? reply.inputTokens ?? 0;
  const output = firstFinite(raw.output_tokens, raw.completion_tokens) ?? 0;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

function firstFinite(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (Number.isFinite(value)) return value as number;
  }
  return undefined;
}

type OpenState = {
  type: 'text' | 'think' | 'tool';
  itemId: string;
  outputIndex: number;
  buffer: string;
  callId?: string;
  name?: string;
};

export class ResponsesStreamDecoder {
  private started = false;
  private terminal = false;
  private sawTool = false;
  private readonly open = new Map<number, OpenItem>();
  private readonly byItemId = new Map<string, OpenItem>();

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
      throw new Error('Malformed upstream SSE JSON');
    }
    if (!isRecord(payload)) return { events: [], terminal: false };
    if (typeof payload.type !== 'string') return { events: [], terminal: false };
    switch (payload.type) {
      case 'ping':
        return { events: [], terminal: false };
      case 'response.created':
      case 'response.in_progress': {
        if (this.started) return { events: [], terminal: false };
        this.started = true;
        const response = isRecord(payload.response) ? payload.response : {};
        return {
          events: [
            {
              type: 'start',
              id: typeof response.id === 'string' ? response.id : '',
              model: typeof response.model === 'string' ? response.model : '',
            },
          ],
          terminal: false,
        };
      }
      case 'response.output_item.added':
        return this.outputItemAdded(payload);
      case 'response.output_item.done': {
        const index = Number(payload.output_index);
        this.open.delete(index);
        return { events: [], terminal: false };
      }
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_text.done':
        if (payload.type === 'response.output_text.done')
          return this.textDoneFallback(payload, 'text', typeof payload.text === 'string' ? payload.text : '');
        return { events: [], terminal: false };
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        return this.deltaAt(payload, 'text', typeof payload.delta === 'string' ? payload.delta : '');
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta':
        return this.deltaAt(payload, 'think', typeof payload.delta === 'string' ? payload.delta : '');
      case 'response.reasoning_text.done':
      case 'response.reasoning_summary_text.done':
        return this.textDoneFallback(payload, 'think', typeof payload.text === 'string' ? payload.text : '');
      case 'response.function_call_arguments.delta':
        if (this.openTool(payload))
          return { events: [{ type: 'tool_args', args: typeof payload.delta === 'string' ? payload.delta : '' }], terminal: false };
        return { events: [], terminal: false };
      case 'response.function_call_arguments.done':
        return { events: [], terminal: false };
      case 'response.completed':
      case 'response.incomplete': {
        this.terminal = true;
        const response = isRecord(payload.response) ? payload.response : {};
        const stop: IrStop = this.sawTool ? 'tool' : payload.type === 'response.incomplete' ? 'length' : 'stop';
        const events: IrEvent[] = [{ type: 'stop', stop }];
        if (isRecord(response.usage)) events.push({ type: 'usage', raw: response.usage });
        return { events, terminal: true };
      }
      case 'response.failed': {
        this.terminal = true;
        const response = isRecord(payload.response) ? payload.response : {};
        const err = isRecord(response.error) ? response.error : {};
        return {
          events: [{ type: 'error', message: typeof err.message === 'string' ? err.message : 'upstream reported response.failed' }],
          terminal: true,
        };
      }
      case 'response.error':
      case 'error': {
        this.terminal = true;
        const message =
          typeof payload.message === 'string'
            ? payload.message
            : typeof payload.error === 'object' && isRecord(payload.error) && typeof payload.error.message === 'string'
              ? payload.error.message
              : 'upstream stream error';
        return { events: [{ type: 'error', message }], terminal: true };
      }
      default:
        return { events: [], terminal: false };
    }
  }

  private outputItemAdded(payload: Record<string, unknown>): { events: IrEvent[]; terminal: boolean } {
    const index = Number(payload.output_index) || 0;
    const item = isRecord(payload.item) ? payload.item : {};
    const itemId = typeof item.id === 'string' ? item.id : '';
    switch (item.type) {
      case 'function_call': {
        this.sawTool = true;
        const state: OpenItem = { type: 'tool', itemId, streamed: true };
        this.open.set(index, state);
        if (itemId) this.byItemId.set(itemId, state);
        return {
          events: [
            {
              type: 'tool_start',
              id: typeof item.call_id === 'string' && item.call_id ? item.call_id : itemId,
              name: typeof item.name === 'string' ? item.name : '',
            },
          ],
          terminal: false,
        };
      }
      case 'message': {
        const state: OpenItem = { type: 'text', itemId, streamed: false };
        this.open.set(index, state);
        if (itemId) this.byItemId.set(itemId, state);
        return { events: [], terminal: false };
      }
      case 'reasoning': {
        const state: OpenItem = { type: 'think', itemId, streamed: false };
        this.open.set(index, state);
        if (itemId) this.byItemId.set(itemId, state);
        if (typeof item.encrypted_content === 'string' && item.encrypted_content) {
          return { events: [{ type: 'sealed', text: item.encrypted_content }], terminal: false };
        }
        return { events: [], terminal: false };
      }
      default: {
        // Unknown provider-native output items (web_search_call, image
        // generation, MCP tools...) have no cross-protocol form.
        const state: OpenItem = { type: 'other', itemId, streamed: true };
        this.open.set(index, state);
        return { events: [], terminal: false };
      }
    }
  }

  private resolve(payload: Record<string, unknown>): OpenItem | undefined {
    if (Number.isFinite(payload.output_index)) {
      const state = this.open.get(Number(payload.output_index));
      if (state) return state;
    }
    const itemId = typeof payload.item_id === 'string' ? payload.item_id : '';
    if (itemId) return this.byItemId.get(itemId);
    return undefined;
  }

  private deltaAt(payload: Record<string, unknown>, expected: 'text' | 'think', value: string): { events: IrEvent[]; terminal: boolean } {
    const state = this.resolve(payload);
    if (!state || state.type !== expected || !value) return { events: [], terminal: false };
    state.streamed = true;
    return { events: [expected === 'text' ? { type: 'text', text: value } : { type: 'think', text: value }], terminal: false };
  }

  private textDoneFallback(payload: Record<string, unknown>, type: 'text' | 'think', text: string): { events: IrEvent[]; terminal: boolean } {
    const state = this.resolve(payload);
    if (!state || state.type !== type || state.streamed || !text) return { events: [], terminal: false };
    state.streamed = true;
    return { events: [{ type, text }], terminal: false };
  }

  private openTool(payload: Record<string, unknown>): boolean {
    const state = this.resolve(payload);
    return !!state && state.type === 'tool';
  }
}

export class ResponsesStreamEncoder {
  private readonly builder = new ResponsesEventBuilder();
  private readonly items: Record<string, unknown>[] = [];
  private created = false;
  private open: OpenState | null = null;

  write(event: IrEvent): string[] {
    switch (event.type) {
      case 'start': {
        if (this.created) return [];
        this.created = true;
        return [
          this.builder.response_created({
            id: event.id,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            status: 'in_progress',
            model: event.model,
            output: [],
            error: null,
            incomplete_details: null,
            usage: null,
          }),
        ];
      }
      case 'think': {
        const out = this.ensureOpen('think');
        if (this.open?.type === 'think') out.push(this.builder.reasoning_text_delta(this.open.itemId, this.open.outputIndex, event.text));
        return out;
      }
      case 'sig':
        return [];
      case 'text': {
        const out = this.ensureOpen('text');
        if (this.open?.type === 'text') out.push(this.builder.output_text_delta(this.open.itemId, this.open.outputIndex, event.text));
        return out;
      }
      case 'tool_start': {
        const out = this.closeCurrent();
        const outputIndex = this.items.length;
        const itemId = `fc_${outputIndex}`;
        this.open = { type: 'tool', itemId, outputIndex, buffer: '', callId: event.id, name: event.name };
        out.push(
          this.builder.output_item_added(outputIndex, {
            type: 'function_call',
            id: itemId,
            call_id: event.id,
            name: event.name,
            arguments: '',
            status: 'in_progress',
          }),
        );
        return out;
      }
      case 'tool_args':
        if (this.open?.type !== 'tool') return [];
        this.open.buffer += event.args;
        return [this.builder.function_call_arguments_delta(this.open.itemId, this.open.outputIndex, event.args)];
      case 'sealed': {
        const out = this.closeCurrent();
        const outputIndex = this.items.length;
        const item = { type: 'reasoning', id: `rs_${outputIndex}`, encrypted_content: event.text };
        out.push(this.builder.output_item_added(outputIndex, item));
        this.items.push(item);
        out.push(this.builder.output_item_done(outputIndex, item));
        return out;
      }
      case 'stop':
      case 'usage':
        // Buffered: finish(reply) owns the reply tail.
        return [];
      default:
        return [];
    }
  }

  finish(reply: IrReply): string[] {
    const chunks = this.closeCurrent();
    const status = reply.stop === 'length' ? 'incomplete' : 'completed';
    const response: Record<string, unknown> = {
      id: reply.id || 'resp_translated',
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: reply.model,
      output: this.items,
      error: null,
      incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      usage: responsesUsageFromRaw(reply),
    };
    chunks.push(status === 'incomplete' ? this.builder.response_incomplete(response) : this.builder.response_completed(response));
    return chunks;
  }

  private ensureOpen(type: 'text' | 'think'): string[] {
    if (this.open?.type === type) return [];
    const out = this.closeCurrent();
    const outputIndex = this.items.length;
    const itemId = type === 'text' ? `msg_${outputIndex}` : `rs_${outputIndex}`;
    this.open = { type, itemId, outputIndex, buffer: '' };
    if (type === 'text') {
      out.push(this.builder.output_item_added(outputIndex, { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] }));
      out.push(this.builder.content_part_added(itemId, outputIndex));
    } else {
      out.push(this.builder.output_item_added(outputIndex, { type: 'reasoning', id: itemId, summary: [] }));
    }
    return out;
  }

  private closeCurrent(): string[] {
    const open = this.open;
    this.open = null;
    if (!open) return [];
    const out: string[] = [];
    if (open.type === 'text') {
      const item = {
        type: 'message',
        id: open.itemId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: open.buffer, annotations: [] }],
      };
      this.items.push(item);
      out.push(this.builder.output_text_done(open.itemId, open.outputIndex, open.buffer));
      out.push(this.builder.content_part_done(open.itemId, open.outputIndex, open.buffer));
      out.push(this.builder.output_item_done(open.outputIndex, item));
    } else if (open.type === 'think') {
      const item = { type: 'reasoning', id: open.itemId, summary: open.buffer ? [{ type: 'summary_text', text: open.buffer }] : [] };
      this.items.push(item);
      if (open.buffer) out.push(this.builder.reasoning_text_done(open.itemId, open.outputIndex, open.buffer));
      out.push(this.builder.output_item_done(open.outputIndex, item));
    } else {
      const item = {
        type: 'function_call',
        id: open.itemId,
        call_id: open.callId || open.itemId,
        name: open.name || 'tool',
        arguments: open.buffer,
        status: 'completed',
      };
      this.items.push(item);
      out.push(this.builder.function_call_arguments_done(open.itemId, open.outputIndex, open.buffer));
      out.push(this.builder.output_item_done(open.outputIndex, item));
    }
    return out;
  }
}
