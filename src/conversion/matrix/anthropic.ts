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
  type IrDocumentPart,
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
  'service_tier',
  'speed',
  'inference_geo',
  'container',
  'betas',
] as const;

// Delivery hints (priority tier, fast mode, data residency) steer the Anthropic
// serving path only; no Chat or Responses equivalent exists, so they are dropped.
const REQUEST_HINT_FIELDS = ['service_tier', 'speed', 'inference_geo'] as const;

// `citations` echoes earlier cited output back; it steers nothing on a Chat or Responses target.
const IGNORABLE_FIELDS = ['cache_control', 'citations'] as const;

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
    // `type: "custom"` is the explicit spelling of a plain client function tool.
    if ((!rawTool.type || rawTool.type === 'custom') && typeof rawTool.name === 'string') {
      assertFields(rawTool, ['type', 'name', 'description', 'input_schema', ...TOOL_HINT_FIELDS, ...IGNORABLE_FIELDS], 'tool');
      // Tool hints have no Chat or Responses equivalent; report that they were dropped.
      if (TOOL_HINT_FIELDS.some((field) => rawTool[field] !== undefined)) diag.add({ feature: 'tool_hints', action: 'dropped' });
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
  // `display` only chooses how Anthropic returns thinking text; it carries no semantics to translate.
  assertFields(thinking, ['type', 'budget_tokens', 'display'], 'thinking');
  if (thinking.type === 'disabled') return null;
  // Adaptive thinking has no fixed budget: the model decides, steered by output_config.effort.
  if (thinking.type === 'adaptive') return undefined;
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
    throw new ConversionError('conversion_not_supported: invalid output_config.format');
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

function systemToIr(body: Record<string, unknown>): string[] {
  const system = body.system;
  if (system === undefined || system === null) return [];
  if (typeof system === 'string') return system ? [system] : [];
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
  return parts.length ? [parts.join('\n')] : [];
}

function systemMessageParts(content: unknown): IrPart[] {
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new ConversionError('conversion_not_supported: system message content must be text');
  const parts: IrPart[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push({ type: 'text', text: block });
      continue;
    }
    if (isRecord(block) && block.type === 'text') {
      assertFields(block, ['type', 'text', ...IGNORABLE_FIELDS], 'system message block');
      if (typeof block.text !== 'string') throw new ConversionError('conversion_not_supported: non-text system message block');
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    throw new ConversionError('conversion_not_supported: system message content must be text');
  }
  return parts;
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

/**
 * Anthropic `document` block. Inline base64 documents travel as a document part; a
 * plain-text source is just text. URL and content-block sources have no portable
 * inline form and fail closed.
 */
function documentFromAnthropic(block: Record<string, unknown>, diag: MatrixDiag): IrPart {
  assertFields(block, ['type', 'source', 'title', 'context', ...IGNORABLE_FIELDS], 'document block');
  const source = block.source;
  if (!isRecord(source)) throw new ConversionError('conversion_not_supported: invalid document source');
  if (source.type === 'text') {
    assertFields(source, ['type', 'media_type', 'data'], 'document source');
    if (typeof source.data !== 'string') throw new ConversionError('conversion_not_supported: document text source data is required');
    diag.add({ feature: 'document', action: 'emulated' });
    return { type: 'text', text: source.data };
  }
  if (source.type === 'base64') {
    assertFields(source, ['type', 'media_type', 'data'], 'document source');
    const data = typeof source.data === 'string' ? source.data : '';
    if (!data) throw new ConversionError('conversion_not_supported: document source data is required');
    const mediaType = typeof source.media_type === 'string' && source.media_type ? source.media_type : 'application/pdf';
    const title = typeof block.title === 'string' ? block.title.trim() : '';
    diag.add({ feature: 'document', action: 'mapped' });
    return { type: 'document', mediaType, data, filename: title || (mediaType === 'application/pdf' ? 'document.pdf' : 'document') };
  }
  throw new ConversionError(`conversion_not_supported: document source "${String(source.type)}"`);
}

function userBlocksToParts(content: unknown, diag: MatrixDiag): IrPart[] {
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
      assertFields(block, ['type', 'source', ...IGNORABLE_FIELDS], 'image block');
      parts.push(imagePartFromAnthropic(block.source));
      continue;
    }
    if (block.type === 'document') {
      parts.push(documentFromAnthropic(block, diag));
      continue;
    }
    if (block.type === 'tool_result') {
      assertFields(block, ['type', 'tool_use_id', 'content', 'is_error', ...IGNORABLE_FIELDS], 'tool_result');
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id)
        throw new ConversionError('conversion_not_supported: tool_result.tool_use_id is required');
      const images: IrImagePart[] = [];
      const documents: IrDocumentPart[] = [];
      const text = toolResultText(block.content, { images, documents }, diag);
      parts.push({
        type: 'tool_result',
        callId: block.tool_use_id,
        text,
        images,
        ...(documents.length ? { documents } : {}),
        ...(block.is_error === true ? { isError: true } : {}),
      });
      continue;
    }
    throw new ConversionError(`conversion_not_supported: user content.${String(block.type)}`);
  }
  return parts;
}

function toolResultText(content: unknown, extras: { images: IrImagePart[]; documents: IrDocumentPart[] }, diag: MatrixDiag): string {
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
      assertFields(part, ['type', 'source', ...IGNORABLE_FIELDS], 'tool_result image');
      extras.images.push(imagePartFromAnthropic(part.source));
      texts.push('[image attached to the tool result]');
    } else if (isRecord(part) && part.type === 'document') {
      const document = documentFromAnthropic(part, diag);
      if (document.type === 'document') {
        extras.documents.push(document);
        texts.push('[document attached to the tool result]');
      } else if (document.type === 'text') texts.push(document.text);
    } else if (isRecord(part) && part.type === 'tool_reference') {
      // Tool-search result marker: the loaded tool is not callable on the target, keep a readable trace.
      assertFields(part, ['type', 'tool_name', ...IGNORABLE_FIELDS], 'tool_reference');
      diag.add({ feature: 'tool_reference', action: 'emulated' });
      texts.push(typeof part.tool_name === 'string' && part.tool_name ? `[tool reference: ${part.tool_name}]` : '[tool reference]');
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
      // caller / toolset_name are Anthropic routing hints with no Chat or Responses meaning: dropped.
      assertFields(block, ['type', 'id', 'name', 'input', 'caller', 'toolset_name', ...IGNORABLE_FIELDS], 'tool_use');
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
    // Advisor history is provider-native and droppable; any other server tool
    // (web_search, ...) or unknown block fails closed, as the legacy validator did.
    if (block.type === 'server_tool_use' && block.name !== 'advisor') {
      throw new ConversionError('conversion_not_supported: server_tool_use blocks not supported');
    }
    if (block.type === 'server_tool_use' || block.type === 'advisor_tool_result') {
      diag.add({ feature: 'provider_native_tool_history', action: 'dropped' });
      continue;
    }
    throw new ConversionError(`conversion_not_supported: ${String(block.type)} blocks not supported`);
  }
  return parts;
}

/** Parse an Anthropic Messages request body into the canonical IR. */
export function parseAnthropicRequest(body: Record<string, unknown>): { request: IrRequest; diag: MatrixDiag } {
  if (!isRecord(body)) throw new ConversionError('conversion_not_supported: request body is not an object');
  assertFields(body, ANTHROPIC_ALLOWED_FIELDS, 'request');
  const diag = new MatrixDiag();
  if (body.metadata !== undefined) diag.add({ feature: 'metadata', action: 'dropped' });
  // Beta feature flags (Claude Code sends e.g. context-management /
  // interleaved-thinking) steer provider-native behavior; a native Anthropic
  // pass forwards them untouched, while cross-protocol targets cannot honor
  // them, so the conversion reports the drop instead of rejecting the request.
  if (body.betas !== undefined && body.betas !== null) diag.add({ feature: 'betas', action: 'dropped' });
  if (body.context_management !== undefined) diag.add({ feature: 'context_management', action: 'dropped' });
  if (body.mcp_servers !== undefined) diag.add({ feature: 'provider_native_tool', action: 'dropped' });
  // A container belongs to the server-side code-execution tool; it cannot be carried over.
  if (body.container !== undefined && body.container !== null) diag.add({ feature: 'provider_native_tool', action: 'dropped' });
  if (REQUEST_HINT_FIELDS.some((field) => body[field] !== undefined && body[field] !== null))
    diag.add({ feature: 'request_hints', action: 'dropped' });
  const structured = anthroParseStructured(body, diag);

  const choice = anthroToolChoice(body);
  // Parallel-tool, thinking and effort controls are carried through the IR (mapped, not dropped).
  if (isRecord(body.tool_choice) && body.tool_choice.disable_parallel_tool_use !== undefined) {
    diag.add({ feature: 'parallel_tool_control', action: 'mapped' });
  }
  if (isRecord(body.thinking) && body.thinking.type === 'enabled') diag.add({ feature: 'thinking_control', action: 'mapped' });
  if (isRecord(body.output_config) && body.output_config.effort !== undefined) diag.add({ feature: 'effort_control', action: 'mapped' });
  const thinkingEffort = anthroThinking(body);
  const maxTokens = typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : null;
  if (body.max_tokens !== undefined && body.max_tokens !== null && (typeof body.max_tokens !== 'number' || body.max_tokens <= 0)) {
    throw new ConversionError('conversion_not_supported: max_tokens must be a positive number');
  }
  // Anthropic REQUIRES max_tokens on /v1/messages; the legacy default-path
  // converter tolerated omission with a 1024 default and cross-protocol
  // fallback keeps that tolerance (buildAnthropicRequest applies the default).
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
    stop:
      typeof body.stop_sequences === 'string'
        ? [body.stop_sequences]
        : Array.isArray(body.stop_sequences) && body.stop_sequences.every((s) => typeof s === 'string')
          ? (body.stop_sequences as string[])
          : [],
    ...(effort === undefined ? {} : { effort }),
    ...(structured ? { structuredOutputSchema: structured } : {}),
  };
  if (body.temperature !== undefined && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 1)) {
    throw new ConversionError('conversion_not_supported: temperature must be between 0 and 1');
  }
  if (body.top_p !== undefined && (typeof body.top_p !== 'number' || body.top_p < 0 || body.top_p > 1)) {
    throw new ConversionError('conversion_not_supported: top_p must be between 0 and 1');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new ConversionError('conversion_not_supported: stream must be boolean');
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new ConversionError('conversion_not_supported: tools must be an array');
  }
  if (body.stop_sequences !== undefined && body.stop_sequences !== null) {
    if (Array.isArray(body.stop_sequences)) {
      if (!body.stop_sequences.every((s) => typeof s === 'string')) {
        throw new ConversionError('conversion_not_supported: invalid stop_sequences');
      }
    } else if (typeof body.stop_sequences !== 'string') {
      throw new ConversionError('conversion_not_supported: invalid stop_sequences');
    }
  }
  // A forced tool that was dropped with the provider-native pool (advisor,
  // web_search, ...) cannot be represented on the target; reject it like the
  // legacy converter so cross-protocol fallback never degrades silently.
  if (request.toolChoice?.startsWith('name:') && Array.isArray(body.tools)) {
    const forced = request.toolChoice.slice('name:'.length);
    const kept = new Set(request.tools.map((tool) => tool.name));
    if (!kept.has(forced) && body.tools.some((tool) => isRecord(tool) && tool.name === forced)) {
      throw new ConversionError(`conversion_not_supported: tool_choice references Anthropic-only server tool ${forced}`);
    }
  }

  if (!Array.isArray(body.messages)) throw new ConversionError('conversion_not_supported: messages must be an array');
  for (const raw of body.messages) {
    if (!isRecord(raw)) throw new ConversionError('conversion_not_supported: messages entry is not an object');
    assertFields(raw, ['role', 'content', 'tool_use_id', 'output_config'], 'message');
    if (raw.role === 'user') {
      request.messages.push({
        role: 'user',
        parts: userBlocksToParts(raw.content, diag),
        ...(typeof raw.content === 'string' ? { stringContent: true } : {}),
      });
      continue;
    }
    if (raw.role === 'tool') {
      // Non-standard role some OpenAI-style clients emit through Anthropic
      // gateways; same semantics as a tool_result wait inside a user message.
      const callId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '';
      if (!callId) throw new ConversionError('conversion_not_supported: tool message missing tool_use_id');
      const images: IrImagePart[] = [];
      const documents: IrDocumentPart[] = [];
      const text = toolResultText(raw.content, { images, documents }, diag);
      request.messages.push({ role: 'user', parts: [{ type: 'tool_result', callId, text, images, ...(documents.length ? { documents } : {}) }] });
      continue;
    }
    if (raw.role === 'system') {
      // Mid-conversation system runs are legal on the wire (mode switches);
      // keep them positionally as system IR messages, mirroring the legacy
      // converter's message-level support for message.output_config effort.
      if (raw.output_config !== undefined) {
        if (!isRecord(raw.output_config)) throw new ConversionError('conversion_not_supported: message.output_config must be an object');
        assertFields(raw.output_config, ['effort'], 'message.output_config');
        const msgEffort = raw.output_config.effort;
        if (msgEffort === undefined || msgEffort === null) {
          // tolerated no-op, like the legacy converter
        } else if (typeof msgEffort === 'string' && EFFORT_VALUES.includes(msgEffort as (typeof EFFORT_VALUES)[number])) {
          if (request.effort === undefined) request.effort = normalizeAnthropicEffort(msgEffort);
          else diag.add({ feature: 'effort_control', action: 'dropped' });
        } else {
          throw new ConversionError(`conversion_not_supported: message.output_config.effort "${String(msgEffort)}"`);
        }
      }
      request.messages.push({ role: 'system', parts: systemMessageParts(raw.content) });
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
    // Anthropic requires at least one content block per message. A turn whose
    // every part was dropped (an empty assistant turn, a reasoning-only turn
    // this target cannot keep) would be sent as an invalid empty content list.
    if (blocks.length === 0) {
      diag.add({ feature: 'empty_turn', action: 'dropped' });
      continue;
    }
    const previous = messages[messages.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = [...contentBlocksOf(previous.content), ...blocks];
      continue;
    }
    messages.push({ role: message.role, content: message.stringContent ? stringOrBlocks(blocks) : blocks });
  }
  if (messages.length === 0) throw new ConversionError('conversion_not_supported: translated conversation is empty');
  out.messages = messages;

  // Anthropic system is a top-level field; text-only system survives.
  const systemSegments = [...ir.system];
  if (ir.structuredOutputSchema) systemSegments.push(structuredOutputInstruction(ir.structuredOutputSchema));
  // One segment stays a plain string; several become text blocks (the legacy shape).
  if (systemSegments.length === 1) out.system = systemSegments[0];
  else if (systemSegments.length > 1) out.system = systemSegments.map((text) => ({ type: 'text', text }));

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
    // Anthropic requires object-shaped input schemas; the legacy converter
    // enforced/forced `type: 'object'` up front rather than shipping a request
    // the upstream would reject.
    out.tools = ir.tools.map((tool) => {
      const schema = isRecord(tool.schema) ? tool.schema : {};
      if (schema.type !== undefined && schema.type !== 'object') {
        throw new ConversionError('conversion_not_supported: tool schema must describe an object');
      }
      return {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        input_schema: { ...schema, type: 'object' },
      };
    });
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

/** Block list for a message already on the wire, whichever shape it was first written in. */
function contentBlocksOf(content: unknown): unknown[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content as unknown[];
}

/** A plain-text string source stays a string on the wire. */
function stringOrBlocks(blocks: Record<string, unknown>[]): unknown {
  const [only] = blocks;
  if (blocks.length === 0) return '';
  if (blocks.length === 1 && only?.type === 'text') return only.text;
  return blocks;
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
      // A sealed block (Anthropic redacted_thinking, Responses
      // encrypted_content) carries an opaque payload the target can replay
      // verbatim. Anthropic accepts it as a redacted_thinking block, so the
      // reasoning history survives the translation instead of being dropped.
      if (part.sealed && part.data) {
        diag.add({ feature: 'thinking_history', action: 'mapped' });
        blocks.push({ type: 'redacted_thinking', data: part.data });
        continue;
      }
      // Anthropic API rejects thinking blocks whose signature cannot be
      // verified; reasoning summaries picked up from other protocols carry no
      // signature, so they are history that this target cannot legally keep.
      if (part.sealed || !part.text || !part.signature) {
        diag.add({ feature: 'thinking_history', action: 'dropped' });
        continue;
      }
      diag.add({ feature: 'thinking_history', action: 'mapped' });
      blocks.push({ type: 'thinking', thinking: part.text, signature: part.signature });
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
      const imageBlocks = part.images.map((image) => ({ type: 'image', source: imageSource(image) }));
      // Text-only tool results stay a plain string (the legacy shape).
      const content = imageBlocks.length ? [{ type: 'text', text: part.text }, ...imageBlocks] : part.text;
      blocks.push({ type: 'tool_result', tool_use_id: part.callId, content, ...(part.isError ? { is_error: true } : {}) });
    }
  }
  return blocks;
}

function imageSource(part: IrImagePart): Record<string, unknown> {
  if (part.data) return { type: 'base64', media_type: part.mediaType || 'image/png', data: part.data };
  return { type: 'url', url: part.url };
}

type IrMessageLike = { role: 'user' | 'assistant' | 'system'; parts: IrPart[]; stringContent?: boolean };

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
      // The sealed payload is opaque but replayable: keep it so a client that
      // replays the reasoning history (or a target that accepts
      // encrypted_content) receives the original blob instead of an empty one.
      const data = typeof block.data === 'string' ? block.data : '';
      diag.add({ feature: 'thinking_history', action: data ? 'mapped' : 'dropped' });
      parts.push({ type: 'thinking', text: '', sealed: true, ...(data ? { data } : {}) });
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
    throw new ConversionError(`conversion_not_supported: unsupported Anthropic response content type "${String(block.type)}"`);
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
