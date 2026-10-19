// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Anthropic Messages side of the translation matrix: request parse/build and
// whole-object round trips. Streaming decode/encode lives in
// anthropic-stream.ts.

import { ConversionError } from '../validation.ts';
import { structuredOutputInstruction } from './chat.ts';
import { MatrixDiag } from './diag.ts';
import {
  budgetToEffort,
  effortToBudget,
  type IrImagePart,
  type IrPart,
  type IrReply,
  type IrRequest,
  type IrStop,
  type IrTool,
  isRecord,
  THINKING_HEADROOM,
} from './ir.ts';

export { ConversionError };

const ANTHROPIC_ALLOWED_FIELDS = [
  'model',
  'messages',
  'system',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stream',
  'stop_sequences',
  'tools',
  'tool_choice',
  'metadata',
  'thinking',
  'output_config',
  'context_management',
  'cache_control',
  'mcp_servers',
] as const;

const IGNORABLE_FIELDS = ['cache_control'] as const;

const TOOL_HINT_FIELDS = ['allowed_callers', 'defer_loading', 'strict', 'input_examples', 'eager_input_streaming'] as const;

const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function assertFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (!allowed.includes(key)) throw new ConversionError(`conversion_not_supported: unknown ${label} field "${key}"`);
  }
}

function anthroParseTools(body: Record<string, unknown>, diag: MatrixDiag): IrTool[] {
  const tools: IrTool[] = [];
  for (const rawTool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isRecord(rawTool)) throw new ConversionError('conversion_not_supported: tools entry is not an object');
    if (!rawTool.type && typeof rawTool.name === 'string') {
      assertFields(rawTool, ['name', 'description', 'input_schema', ...TOOL_HINT_FIELDS, ...IGNORABLE_FIELDS], 'tool');
      if (!rawTool.name || !isRecord(rawTool.input_schema))
        throw new ConversionError('conversion_not_supported: tool requires name and input_schema');
      tools.push({
        name: rawTool.name,
        ...(typeof rawTool.description === 'string' ? { description: rawTool.description } : {}),
        schema: rawTool.input_schema,
      });
      continue;
    }
    // Provider-native server tools (web_search, advisor, ...) have no
    // portable function form: report them so the caller can gate the route.
    diag.add({ feature: 'provider_native_tool', action: 'dropped' });
  }
  return tools;
}

function anthroToolChoice(body: Record<string, unknown>): { choice: IrRequest['toolChoice']; parallel: boolean | null } {
  const raw = body.tool_choice;
  if (raw === undefined || raw === null) return { choice: undefined, parallel: null };
  if (!isRecord(raw)) throw new ConversionError('conversion_not_supported: tool_choice must be an object');
  assertFields(raw, ['type', 'name', 'disable_parallel_tool_use'], 'tool_choice');
  let parallel: boolean | null = null;
  if (raw.disable_parallel_tool_use === true) parallel = false;
  if (raw.type === 'auto') return { choice: 'auto', parallel };
  if (raw.type === 'none') return { choice: 'none', parallel };
  if (raw.type === 'any') return { choice: 'required', parallel };
  if (raw.type === 'tool') {
    if (typeof raw.name !== 'string' || !raw.name) throw new ConversionError('conversion_not_supported: tool_choice.name is required');
    return { choice: `name:${raw.name}`, parallel };
  }
  throw new ConversionError(`conversion_not_supported: tool_choice type "${String(raw.type)}"`);
}

function anthroThinking(body: Record<string, unknown>): IrEffortOrUndefined {
  const thinking = body.thinking;
  if (thinking === undefined || thinking === null) return undefined;
  if (!isRecord(thinking)) throw new ConversionError('conversion_not_supported: thinking must be an object');
  assertFields(thinking, ['type', 'budget_tokens'], 'thinking');
  if (thinking.type === 'disabled') return null;
  if (thinking.type === 'enabled') {
    const budget = typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : 0;
    if (!budget) throw new ConversionError('conversion_not_supported: thinking.budget_tokens is required');
    return budgetToEffort(budget);
  }
  throw new ConversionError(`conversion_not_supported: thinking.type "${String(thinking.type)}"`);
}

type IrEffortOrUndefined = IrRequest['effort'];

function anthroParseStructured(body: Record<string, unknown>, diag: MatrixDiag): Record<string, unknown> | null {
  const outputConfig = body.output_config;
  if (outputConfig === undefined) return null;
  if (!isRecord(outputConfig)) throw new ConversionError('conversion_not_supported: output_config must be an object');
  assertFields(outputConfig, ['effort', 'format'], 'output_config');
  if (outputConfig.format === undefined) return null;
  if (!isRecord(outputConfig.format)) throw new ConversionError('conversion_not_supported: output_config.format must be an object');
  assertFields(outputConfig.format, ['type', 'schema'], 'output_config.format');
  if (outputConfig.format.type !== 'json_schema' || !isRecord(outputConfig.format.schema)) {
    throw new ConversionError('conversion_not_supported: only output_config.format type json_schema is supported');
  }
  diag.add({ feature: 'structured_output', action: 'emulated', strategy: 'prompt' });
  return outputConfig.format.schema as Record<string, unknown>;
}

function parseEffortFromOutputConfig(body: Record<string, unknown>): IrEffortOrUndefined {
  const outputConfig = body.output_config;
  if (!isRecord(outputConfig) || outputConfig.effort === undefined || outputConfig.effort === null) return undefined;
  if (typeof outputConfig.effort !== 'string' || !EFFORT_VALUES.includes(outputConfig.effort as (typeof EFFORT_VALUES)[number])) {
    throw new ConversionError(`conversion_not_supported: output_config.effort "${String(outputConfig.effort)}"`);
  }
  return normalizeAnthropicEffort(outputConfig.effort);
}

function normalizeAnthropicEffort(value: string): IrEffortOrUndefined {
  if (value === 'xhigh') return 'max';
  return value as IrEffortOrUndefined;
}

function systemToIr(body: Record<string, unknown>): string {
  const system = body.system;
  if (system === undefined || system === null) return '';
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) throw new ConversionError('conversion_not_supported: invalid system');
  const parts: string[] = [];
  for (const block of system) {
    if (typeof block === 'string') parts.push(block);
    else if (isRecord(block) && block.type === 'text') {
      assertFields(block, ['type', 'text', ...IGNORABLE_FIELDS], 'system block');
      if (typeof block.text !== 'string') throw new ConversionError('conversion_not_supported: non-text system block');
      parts.push(block.text);
    } else throw new ConversionError('conversion_not_supported: unsupported system block');
  }
  return parts.join('\n');
}

function imagePartFromAnthropic(source: unknown): IrImagePart {
  if (!isRecord(source)) throw new ConversionError('conversion_not_supported: invalid image source');
  assertFields(source, ['type', 'url', 'media_type', 'data'], 'image source');
  if (source.type === 'url') {
    const url = typeof source.url === 'string' ? source.url : '';
    if (!url) throw new ConversionError('conversion_not_supported: image source url is required');
    return { type: 'image', url };
  }
  if (source.type === 'base64') {
    const data = typeof source.data === 'string' ? source.data : '';
    if (!data) throw new ConversionError('conversion_not_supported: image source data is required');
    return {
      type: 'image',
      url: `data:${typeof source.media_type === 'string' ? source.media_type : 'image/png'};base64,${data}`,
      mediaType: typeof source.media_type === 'string' ? source.media_type : 'image/png',
      data,
    };
  }
  throw new ConversionError('conversion_not_supported: unsupported image source');
}

function userBlocksToParts(content: unknown): IrPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new ConversionError('conversion_not_supported: invalid user content');
  const parts: IrPart[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push({ type: 'text', text: block });
      continue;
    }
    if (!isRecord(block)) throw new ConversionError('conversion_not_supported: invalid user content block');
    if (block.type === 'text') {
      assertFields(block, ['type', 'text', ...IGNORABLE_FIELDS], 'user text');
      if (typeof block.text !== 'string') throw new ConversionError('conversion_not_supported: non-text user block');
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      assertFields(block, ['type', 'source'], 'image block');
      parts.push(imagePartFromAnthropic(block.source));
      continue;
    }
    if (block.type === 'tool_result') {
      assertFields(block, ['type', 'tool_use_id', 'content', 'is_error', ...IGNORABLE_FIELDS], 'tool_result');
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id)
        throw new ConversionError('conversion_not_supported: tool_result.tool_use_id is required');
      const images: IrImagePart[] = [];
      const text = toolResultText(block.content, images);
      parts.push({ type: 'tool_result', callId: block.tool_use_id, text, images, ...(block.is_error === true ? { isError: true } : {}) });
      continue;
    }
    throw new ConversionError(`conversion_not_supported: user block "${String(block.type)}"`);
  }
  return parts;
}

function toolResultText(content: unknown, images: IrImagePart[]): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new ConversionError('conversion_not_supported: non-text tool_result content');
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') texts.push(part);
    else if (isRecord(part) && part.type === 'text') {
      assertFields(part, ['type', 'text', ...IGNORABLE_FIELDS], 'tool_result text');
      if (typeof part.text !== 'string') throw new ConversionError('conversion_not_supported: non-text tool_result part');
      texts.push(part.text);
    } else if (isRecord(part) && part.type === 'image') {
      assertFields(part, ['type', 'source'], 'tool_result image');
      images.push(imagePartFromAnthropic(part.source));
      texts.push('[image attached to the tool result]');
    } else throw new ConversionError(`conversion_not_supported: tool_result part "${String(isRecord(part) ? part.type : part)}"`);
  }
  return texts.join('\n');
}

function assistantBlocksToParts(content: unknown, diag: MatrixDiag): IrPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new ConversionError('conversion_not_supported: invalid assistant content');
  const parts: IrPart[] = [];
  for (const block of content) {
    if (!isRecord(block)) throw new ConversionError('conversion_not_supported: invalid assistant content block');
    if (block.type === 'text') {
      assertFields(block, ['type', 'text', ...IGNORABLE_FIELDS], 'assistant text');
      if (typeof block.text !== 'string') throw new ConversionError('conversion_not_supported: non-text assistant block');
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'tool_use') {
      assertFields(block, ['type', 'id', 'name', 'input', ...IGNORABLE_FIELDS], 'tool_use');
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) {
        throw new ConversionError('conversion_not_supported: invalid tool_use block');
      }
      if (!isRecord(block.input)) throw new ConversionError('conversion_not_supported: tool_use input must be an object');
      parts.push({ type: 'tool_call', id: block.id, name: block.name, args: JSON.stringify(block.input) });
      continue;
    }
    if (block.type === 'thinking') {
      assertFields(block, ['type', 'thinking', 'signature', ...IGNORABLE_FIELDS], 'thinking');
      if (typeof block.thinking !== 'string') throw new ConversionError('conversion_not_supported: invalid thinking block');
      diag.add({ feature: 'thinking_history', action: 'mapped' });
      parts.push({
        type: 'thinking',
        text: block.thinking,
        ...(typeof block.signature === 'string' && block.signature ? { signature: block.signature } : {}),
      });
      continue;
    }
    if (block.type === 'redacted_thinking') {
      assertFields(block, ['type', 'data', ...IGNORABLE_FIELDS], 'redacted_thinking');
      if (typeof block.data !== 'string') throw new ConversionError('conversion_not_supported: invalid redacted_thinking block');
      diag.add({ feature: 'thinking_history', action: 'dropped' });
      parts.push({ type: 'thinking', text: '', sealed: true, data: block.data });
      continue;
    }
    // server_tool_use / advisor / etc. - provider-native history cannot be
    // represented on another protocol.
    diag.add({ feature: 'provider_native_tool_history', action: 'dropped' });
    parts.push({ type: 'text', text: '[provider-native tool output omitted in translation]' });
  }
  return parts;
}

/** Parse an Anthropic Messages request body into the canonical IR. */
export function parseAnthropicRequest(body: Record<string, unknown>): { request: IrRequest; diag: MatrixDiag } {
  if (!isRecord(body)) throw new ConversionError('conversion_not_supported: request body is not an object');
  assertFields(body, ANTHROPIC_ALLOWED_FIELDS, 'request');
  const diag = new MatrixDiag();
  if (body.metadata !== undefined) diag.add({ feature: 'metadata', action: 'dropped' });
  if (body.context_management !== undefined) diag.add({ feature: 'context_management', action: 'dropped' });
  if (body.mcp_servers !== undefined) diag.add({ feature: 'provider_native_tool', action: 'dropped' });
  const structured = anthroParseStructured(body, diag);

  const choice = anthroToolChoice(body);
  const thinkingEffort = anthroThinking(body);
  const maxTokens = typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : null;
  if (maxTokens == null) throw new ConversionError('conversion_not_supported: max_tokens is required');
  const effortFromConfig = parseEffortFromOutputConfig(body);
  const effort = thinkingEffort ?? effortFromConfig ?? undefined;

  const request: IrRequest = {
    model: typeof body.model === 'string' && body.model.trim() ? body.model : '',
    system: systemToIr(body),
    messages: [],
    tools: anthroParseTools(body, diag),
    toolChoice: choice.choice,
    parallelToolCalls: choice.parallel,
    maxTokens,
    temperature: typeof body.temperature === 'number' ? body.temperature : null,
    topP: typeof body.top_p === 'number' ? body.top_p : null,
    stop: Array.isArray(body.stop_sequences) && body.stop_sequences.every((s) => typeof s === 'string') ? (body.stop_sequences as string[]) : [],
    ...(effort === undefined ? {} : { effort }),
    ...(structured ? { structuredOutputSchema: structured } : {}),
  };
  if (!request.model) throw new ConversionError('conversion_not_supported: model is required');
  if (request.stop.length && !Array.isArray(body.stop_sequences)) throw new ConversionError('conversion_not_supported: invalid stop_sequences');

  if (!Array.isArray(body.messages)) throw new ConversionError('conversion_not_supported: messages must be an array');
  for (const raw of body.messages) {
    if (!isRecord(raw)) throw new ConversionError('conversion_not_supported: messages entry is not an object');
    assertFields(raw, ['role', 'content', 'tool_use_id'], 'message');
    if (raw.role === 'user') {
      request.messages.push({ role: 'user', parts: userBlocksToParts(raw.content) });
      continue;
    }
    if (raw.role === 'assistant') {
      request.messages.push({ role: 'assistant', parts: assistantBlocksToParts(raw.content, diag) });
      continue;
    }
    throw new ConversionError(`conversion_not_supported: role "${String(raw.role)}"`);
  }
  if (request.messages.length === 0) throw new ConversionError('conversion_not_supported: messages array is empty');
  if (request.tools.length) diag.add({ feature: 'function_tools', action: 'mapped' });
  return { request, diag };
}

// ---- Build: IR -> Anthropic Messages request body --------------------------

export const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

export function buildAnthropicRequest(ir: IrRequest, diag: MatrixDiag): Record<string, unknown> {
  const out: Record<string, unknown> = { model: ir.model };

  // Agentic request bodies: merge alternating user/assistant runs into
  // strict Anthropic turns (never two user messages in a row).
  const messages: Record<string, unknown>[] = [];
  for (const message of ir.messages) {
    const blocks = buildMessageBlocks(message, diag);
    const previous = messages[messages.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = [...(previous.content as unknown[]), ...blocks];
      continue;
    }
    messages.push({ role: message.role, content: blocks });
  }
  if (messages.length === 0) throw new ConversionError('conversion_not_supported: translated conversation is empty');
  out.messages = messages;

  // Anthropic system is a top-level field; text-only system survives.
  if (ir.system) out.system = [{ type: 'text', text: ir.system }];

  if (ir.structuredOutputSchema) {
    out.system = [
      ...(Array.isArray(out.system) ? (out.system as unknown[]) : []),
      { type: 'text', text: structuredOutputInstruction(ir.structuredOutputSchema) },
    ];
  }

  let maxTokens = ir.maxTokens;
  if (maxTokens == null) {
    maxTokens = ANTHROPIC_DEFAULT_MAX_TOKENS;
    diag.add({ feature: 'max_tokens', action: 'defaulted' });
  }
  if (ir.effort) {
    const budget = effortToBudget(ir.effort);
    if (budget + THINKING_HEADROOM > maxTokens) {
      maxTokens = budget + THINKING_HEADROOM;
      diag.add({ feature: 'max_tokens', action: 'defaulted' });
    }
    out.thinking = { type: 'enabled', budget_tokens: budget };
    if (ir.temperature != null || ir.topP != null) diag.add({ feature: 'sampling_control', action: 'dropped' });
  } else {
    if (ir.temperature != null) out.temperature = ir.temperature;
    if (ir.topP != null) out.top_p = ir.topP;
  }
  out.max_tokens = maxTokens;

  if (ir.stop.length) out.stop_sequences = ir.stop;
  if (ir.tools.length) {
    diag.add({ feature: 'function_tools', action: 'mapped' });
    out.tools = ir.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: isRecord(tool.schema) ? tool.schema : {},
    }));
  }
  if (ir.toolChoice || ir.parallelToolCalls === false) {
    const choice: Record<string, unknown> = {};
    if (ir.toolChoice === 'none') choice.type = 'none';
    else if (ir.toolChoice === 'required') choice.type = 'any';
    else if (ir.toolChoice?.startsWith('name:')) {
      choice.type = 'tool';
      choice.name = ir.toolChoice.slice('name:'.length);
    } else if (ir.toolChoice) choice.type = ir.toolChoice;
    if (ir.parallelToolCalls === false && choice.type !== 'none') choice.disable_parallel_tool_use = true;
    if (Object.keys(choice).length) out.tool_choice = choice;
  }
  return out;
}

function buildMessageBlocks(message: IrMessageLike, diag: MatrixDiag): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image') {
      blocks.push({ type: 'image', source: imageSource(part) });
      continue;
    }
    if (part.type === 'thinking') {
      if (part.sealed || !part.text) {
        diag.add({ feature: 'thinking_history', action: 'dropped' });
        continue;
      }
      diag.add({ feature: 'thinking_history', action: 'mapped' });
      blocks.push({ type: 'thinking', thinking: part.text, ...(part.signature ? { signature: part.signature } : {}) });
      continue;
    }
    if (part.type === 'tool_call') {
      diag.add({ feature: 'tool_calls', action: 'mapped' });
      let input: unknown = {};
      try {
        input = JSON.parse(part.args || '{}');
      } catch {
        input = { raw: part.args };
      }
      if (!isRecord(input)) input = { value: input };
      blocks.push({ type: 'tool_use', id: part.id, name: part.name, input });
      continue;
    }
    if (part.type === 'tool_result') {
      diag.add({ feature: 'tool_results', action: 'mapped' });
      const content: unknown[] = [{ type: 'text', text: part.text }];
      const contentBlocks = [...content, ...part.images.map((image) => ({ type: 'image', source: imageSource(image) }))];
      blocks.push({ type: 'tool_result', tool_use_id: part.callId, content: contentBlocks, ...(part.isError ? { is_error: true } : {}) });
    }
  }
  return blocks;
}

function imageSource(part: IrImagePart): Record<string, unknown> {
  if (part.data) return { type: 'base64', media_type: part.mediaType || 'image/png', data: part.data };
  return { type: 'url', url: part.url };
}

type IrMessageLike = { role: 'user' | 'assistant' | 'system'; parts: IrPart[] };

// ---- Whole-object round trips ---------------------------------------------

export function anthropicStopToIr(reason: unknown): IrStop {
  switch (reason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
    case 'tool_calls':
    case 'function_call':
      return 'tool';
    case 'refusal':
    case 'content_filter':
      return 'filter';
    default:
      return 'stop';
  }
}

export function anthropicStopFromIr(stop: IrStop): string {
  switch (stop) {
    case 'length':
      return 'max_tokens';
    case 'tool':
      return 'tool_use';
    case 'filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/** Assemble an Anthropic response object into IR (upstream replies). */
export function anthropicObjectToIr(data: Record<string, unknown>): { reply: IrReply; diag: MatrixDiag } {
  const diag = new MatrixDiag();
  const parts: IrPart[] = [];
  for (const block of Array.isArray(data.content) ? data.content : []) {
    if (!isRecord(block)) continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'thinking') {
      if (typeof block.thinking === 'string') {
        parts.push({
          type: 'thinking',
          text: block.thinking,
          ...(typeof block.signature === 'string' && block.signature ? { signature: block.signature } : {}),
        });
      }
      continue;
    }
    if (block.type === 'redacted_thinking') {
      diag.add({ feature: 'thinking_history', action: 'dropped' });
      parts.push({ type: 'thinking', text: '', sealed: true });
      continue;
    }
    if (block.type === 'tool_use') {
      parts.push({
        type: 'tool_call',
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
        args: JSON.stringify(isRecord(block.input) ? block.input : {}),
      });
      continue;
    }
    diag.add({ feature: 'response_content_type', action: 'dropped' });
  }
  return {
    reply: {
      id: typeof data.id === 'string' ? data.id : '',
      model: typeof data.model === 'string' ? data.model : '',
      parts,
      stop: anthropicStopToIr(data.stop_reason),
      rawUsage: isRecord(data.usage) ? data.usage : null,
      inputTokens: 0,
    },
    diag,
  };
}
