// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Shared private-center native-object decode and IR reply rendering. This module
// does not perform upstream fetch, tier selection or stream settlement.

import { MatrixDiag } from '../diag.ts';
import { type IrProtocol, type IrReply, isRecord } from '../ir.ts';
import type { ConversionDiagnostic } from '../result.ts';
import { ConversionError } from '../validation.ts';
import { anthropicObjectToIr, anthropicStopFromIr } from './anthropic.ts';
import { chatObjectToIr, chatStopFromIr, chatToolId } from './chat.ts';
import { chatUsageFromRaw } from './chat-stream.ts';
import { responsesObjectToIr } from './responses.ts';

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
      // A Responses ciphertext is not an Anthropic signed thinking block.
      // Unsigned reasoning summaries also cannot be safely replayed by clients.
      if (!part.sealed && part.text && part.signature) {
        content.push({ type: 'thinking', thinking: part.text, signature: part.signature });
      }
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
        // A sealed block without a payload carries no replayable content: an
        // empty reasoning item would be a lie about what the upstream returned.
        if (part.data) output.push({ type: 'reasoning', id: `rs_${itemSeed++}`, encrypted_content: part.data });
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
