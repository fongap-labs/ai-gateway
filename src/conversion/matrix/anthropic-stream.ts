// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Anthropic Messages streaming side of the translation matrix.
//
// AnthropicStreamDecoder: upstream Anthropic SSE payloads -> IR events.
// AnthropicStreamEncoder: IR events -> SSE chunks for an Anthropic client.
//
// The decoder closes itself on `message_stop` / `error`; keep-alive ping
// payloads are ignored. The encoder buffers the reply tail (stop reason and
// usage rollup) until finish(reply) is called 鈥?exactly the legacy
// stream-converter lifecycle.

import { anthropicStopFromIr, anthropicStopToIr } from './anthropic.ts';
import type { IrEvent, IrReply } from './ir.ts';
import { isRecord } from './ir.ts';

type OpenBlock = 'text' | 'thinking' | 'tool' | null;

function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export class AnthropicStreamDecoder {
  private readonly openBlocks = new Map<number, OpenBlock>();
  private terminal = false;

  get done(): boolean {
    return this.terminal;
  }

  /** Feed one upstream SSE data payload; returns IR events and terminal state. */
  push(payload: unknown): { events: IrEvent[]; terminal: boolean } {
    if (this.terminal || !isRecord(payload)) return { events: [], terminal: false };
    switch (payload.type) {
      case 'ping':
        return { events: [], terminal: false };
      case 'message_start': {
        const message = isRecord(payload.message) ? payload.message : {};
        const usage = isRecord(message.usage) ? message.usage : {};
        return {
          events: [
            {
              type: 'start',
              id: typeof message.id === 'string' ? message.id : '',
              model: typeof message.model === 'string' ? message.model : '',
              ...(Number.isFinite(usage.input_tokens) ? { inputTokens: Number(usage.input_tokens) } : {}),
            },
          ],
          terminal: false,
        };
      }
      case 'content_block_start': {
        const index = Number(payload.index) || 0;
        const block = isRecord(payload.content_block) ? payload.content_block : {};
        switch (block.type) {
          case 'text':
          case 'thinking':
            this.openBlocks.set(index, block.type as 'text' | 'thinking');
            return { events: [], terminal: false };
          case 'tool_use':
            this.openBlocks.set(index, 'tool');
            return {
              events: [
                { type: 'tool_start', id: typeof block.id === 'string' ? block.id : '', name: typeof block.name === 'string' ? block.name : '' },
              ],
              terminal: false,
            };
          case 'redacted_thinking':
            this.openBlocks.set(index, null);
            return { events: [{ type: 'sealed', text: typeof block.data === 'string' ? block.data : '' }], terminal: false };
          default:
            // server_tool_use / advisor blocks are provider-native history.
            this.openBlocks.set(index, null);
            return { events: [], terminal: false };
        }
      }
      case 'content_block_delta': {
        const index = Number(payload.index) || 0;
        const delta = isRecord(payload.delta) ? payload.delta : {};
        const open = this.openBlocks.get(index);
        switch (delta.type) {
          case 'text_delta':
            return { events: [{ type: 'text', text: typeof delta.text === 'string' ? delta.text : '' }], terminal: false };
          case 'thinking_delta':
            if (open === 'thinking')
              return { events: [{ type: 'think', text: typeof delta.thinking === 'string' ? delta.thinking : '' }], terminal: false };
            return { events: [], terminal: false };
          case 'signature_delta':
            if (open === 'thinking')
              return { events: [{ type: 'sig', signature: typeof delta.signature === 'string' ? delta.signature : '' }], terminal: false };
            return { events: [], terminal: false };
          case 'input_json_delta':
            if (open === 'tool')
              return { events: [{ type: 'tool_args', args: typeof delta.partial_json === 'string' ? delta.partial_json : '' }], terminal: false };
            return { events: [], terminal: false };
          default:
            return { events: [], terminal: false };
        }
      }
      case 'content_block_stop': {
        this.openBlocks.delete(Number(payload.index) || 0);
        return { events: [], terminal: false };
      }
      case 'message_delta': {
        const delta = isRecord(payload.delta) ? payload.delta : {};
        const events: IrEvent[] = [{ type: 'stop', stop: anthropicStopToIr(delta.stop_reason) }];
        if (isRecord(payload.usage)) events.push({ type: 'usage', raw: payload.usage });
        return { events, terminal: false };
      }
      case 'message_stop':
        this.terminal = true;
        return { events: [], terminal: true };
      case 'error': {
        this.terminal = true;
        const err = isRecord(payload.error) ? payload.error : {};
        return { events: [{ type: 'error', message: typeof err.message === 'string' ? err.message : 'upstream stream error' }], terminal: true };
      }
      default:
        return { events: [], terminal: false };
    }
  }
}

export class AnthropicStreamEncoder {
  private open: OpenBlock = null;
  private blockIndex = -1;

  /** Translate one IR event into zero or more client SSE chunks. */
  write(event: IrEvent): string[] {
    switch (event.type) {
      case 'start':
        return [
          sse('message_start', {
            type: 'message_start',
            message: {
              id: event.id,
              type: 'message',
              role: 'assistant',
              model: event.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: event.inputTokens ?? 0, output_tokens: 0 },
            },
          }),
        ];
      case 'think': {
        const out = this.beginBlockChunks('thinking');
        if (this.open === 'thinking') {
          out.push(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: this.blockIndex,
              delta: { type: 'thinking_delta', thinking: event.text },
            }),
          );
        }
        return out;
      }
      case 'sig':
        if (this.open !== 'thinking') return [];
        return [
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndex,
            delta: { type: 'signature_delta', signature: event.signature },
          }),
        ];
      case 'text': {
        const out = this.beginBlockChunks('text');
        if (this.open === 'text') {
          out.push(
            sse('content_block_delta', { type: 'content_block_delta', index: this.blockIndex, delta: { type: 'text_delta', text: event.text } }),
          );
        }
        return out;
      }
      case 'tool_start': {
        const out = this.closeChunks();
        this.blockIndex += 1;
        this.open = 'tool';
        out.push(
          sse('content_block_start', {
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} },
          }),
        );
        return out;
      }
      case 'tool_args':
        if (this.open !== 'tool') return [];
        return [
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndex,
            delta: { type: 'input_json_delta', partial_json: event.args },
          }),
        ];
      case 'sealed': {
        const out = this.closeChunks();
        this.blockIndex += 1;
        out.push(
          sse('content_block_start', {
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'redacted_thinking', data: event.text },
          }),
        );
        out.push(sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex }));
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

  /** Flush the buffered reply tail after the upstream went terminal. */
  finish(reply: IrReply): string[] {
    const chunks = this.closeChunks();
    chunks.push(
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: anthropicStopFromIr(reply.stop), stop_sequence: null },
        usage: anthropicUsageOutput(reply),
      }),
    );
    chunks.push(sse('message_stop', { type: 'message_stop' }));
    return chunks;
  }

  private beginBlockChunks(type: 'text' | 'thinking'): string[] {
    if (this.open === type) return [];
    const out = this.closeChunks();
    this.blockIndex += 1;
    this.open = type;
    out.push(
      sse('content_block_start', {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
      }),
    );
    return out;
  }

  private closeChunks(): string[] {
    if (this.open === null) return [];
    const out = [sse('content_block_stop', { type: 'content_block_stop', index: this.blockIndex })];
    this.open = null;
    return out;
  }
}

function anthropicUsageOutput(reply: IrReply): Record<string, unknown> {
  const raw = isRecord(reply.rawUsage) ? reply.rawUsage : {};
  const output = firstFinite(raw.output_tokens, raw.completion_tokens) ?? 0;
  const input = firstFinite(raw.input_tokens, raw.prompt_tokens) ?? reply.inputTokens ?? 0;
  const usage: Record<string, unknown> = { output_tokens: output };
  if (input) usage.input_tokens = input;
  return usage;
}

function firstFinite(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (Number.isFinite(value)) return value as number;
  }
  return undefined;
}
