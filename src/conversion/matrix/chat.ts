// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// OpenAI Chat Completions side of the translation matrix: request parse/build
// and whole-object round trips. Streaming decode/encode lives in
// chat-stream.ts; this module only handles bodies.

import { ConversionError, parseToolArguments } from '../validation.ts';
import { MatrixDiag } from './diag.ts';
import { type IrEffort, type IrImagePart, type IrPart, type IrReply, type IrRequest, type IrStop, isRecord, normalizeEffort } from './ir.ts';

export { ConversionError };

const CHAT_ALLOWED_FIELDS = [
  'model',
  'messages',
  'system',
  'developer',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'stream',
  'reasoning_effort',
  'parallel_tool_calls',
  'response_format',
] as const;

const IMAGE_URL_TYPE_FIELDS = new Set(['url', 'detail']);

function assertFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (!allowed.includes(key)) throw new ConversionError(`conversion_not_supported: unknown ${label} field "${key}"`);
  }
}

function chatToolChoice(body: Record<string, unknown>): IrRequest['toolChoice'] {
  const raw = body.tool_choice;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    if (raw === 'auto' || raw === 'none' || raw === 'required') return raw;
    throw new ConversionError(`conversion_not_supported: tool_choice "${raw}"`);
  }
  if (!isRecord(raw)) throw new ConversionError('conversion_not_supported: tool_choice must be a string or object');
  assertFields(raw, ['type', 'function', 'tool', 'name'], 'tool_choice');
  if (raw.type === 'function' && isRecord(raw.function)) {
    if (typeof raw.function.name !== 'string' || !raw.function.name) {
      throw new ConversionError('conversion_not_supported: tool_choice.function.name is required');
    }
    return `name:${raw.function.name}`;
  }
  if (raw.type === 'tool' && typeof raw.name === 'string' && raw.name) return `name:${raw.name}`;
  throw new ConversionError('conversion_not_supported: unsupported tool_choice object');
}

function chatParseTools(body: Record<string, unknown>, diag: MatrixDiag): IrRequest['tools'] {
  const tools: NonNullable<IrRequest['tools']> = [];
  for (const rawTool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isRecord(rawTool)) throw new ConversionError('conversion_not_supported: tools entry is not an object');
    if (rawTool.type !== 'function' || !isRecord(rawTool.function)) {
      diag.add({ feature: 'function_tools', action: 'dropped' });
      continue;
    }
    const fn = rawTool.function;
    assertFields(fn, ['name', 'description', 'parameters'], 'tools.function');
    if (typeof fn.name !== 'string' || !fn.name) throw new ConversionError('conversion_not_supported: tool.function.name is required');
    tools.push({
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      schema: isRecord(fn.parameters) ? fn.parameters : {},
    });
  }
  return tools;
}

function chatContentParts(content: unknown, images: IrPart[], diag: MatrixDiag): IrPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new ConversionError('conversion_not_supported: content must be a string or parts array');
  const parts: IrPart[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (!isRecord(part)) throw new ConversionError('conversion_not_supported: content part is not an object');
    if (part.type === 'text') parts.push({ type: 'text', text: typeof part.text === 'string' ? part.text : '' });
    else if (part.type === 'image_url') {
      const iu = isRecord(part.image_url) ? part.image_url : {};
      for (const key of Object.keys(iu)) {
        if (!IMAGE_URL_TYPE_FIELDS.has(key)) {
          diag.add({ feature: 'image_url_extra', action: 'dropped' });
        }
      }
      const url = typeof iu.url === 'string' ? iu.url : '';
      if (!url) throw new ConversionError('conversion_not_supported: image_url.url is required');
      const image: IrPart = { type: 'image', url };
      images.push(image);
      parts.push(image);
    } else if (part.type === 'refusal') {
      parts.push({ type: 'text', text: typeof part.refusal === 'string' ? part.refusal : '' });
    } else throw new ConversionError(`conversion_not_supported: content type "${String(part.type)}"`);
  }
  return parts;
}

/** Parse an OpenAI Chat Completions request body into the canonical IR. */
export function parseChatRequest(body: Record<string, unknown>): { request: IrRequest; diag: MatrixDiag } {
  if (!isRecord(body)) throw new ConversionError('conversion_not_supported: request body is not an object');
  assertFields(body, CHAT_ALLOWED_FIELDS, 'request');
  const diag = new MatrixDiag();
  if (body.metadata !== undefined) diag.add({ feature: 'metadata', action: 'dropped' });
  if (body.user !== undefined) diag.add({ feature: 'user_field', action: 'dropped' });

  const structured = chatStructuredSchema(body, diag);
  const effort = parseChatEffort(body);
  const system: string[] = [];
  if (typeof body.system === 'string' && body.system) system.push(body.system);
  if (Array.isArray(body.developer)) {
    for (const d of body.developer) {
      const text = typeof d === 'string' ? d : isRecord(d) && typeof d.content === 'string' ? d.content : '';
      if (text) system.push(text);
    }
  }
  const request: IrRequest = {
    model: typeof body.model === 'string' && body.model.trim() ? body.model : '',
    system,
    messages: [],
    tools: chatParseTools(body, diag),
    toolChoice: chatToolChoice(body),
    maxTokens: Number.isFinite(body.max_tokens)
      ? Number(body.max_tokens)
      : Number.isFinite(body.max_completion_tokens)
        ? Number(body.max_completion_tokens)
        : null,
    temperature: typeof body.temperature === 'number' ? body.temperature : null,
    topP: typeof body.top_p === 'number' ? body.top_p : null,
    stop: chatStop(body.stop),
    ...(effort === undefined ? {} : { effort }),
    ...(structured ? { structuredOutputSchema: structured.schema } : {}),
    ...(typeof body.parallel_tool_calls === 'boolean' ? { parallelToolCalls: body.parallel_tool_calls } : {}),
  };
  if (!request.model) throw new ConversionError('conversion_not_supported: model is required');
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

  if (!Array.isArray(body.messages)) throw new ConversionError('conversion_not_supported: messages must be an array');
  for (const raw of body.messages) {
    if (!isRecord(raw)) throw new ConversionError('conversion_not_supported: messages entry is not an object');
    assertFields(raw, ['role', 'content', 'tool_calls', 'tool_call_id', 'status', 'is_error', 'reasoning', 'reasoning_content'], 'message');
    const role = raw.role;
    if (role === 'system' || role === 'developer') {
      const text = systemText(raw.content);
      if (text) request.system.push(text);
      continue;
    }
    if (role === 'user') {
      const images: IrPart[] = [];
      request.messages.push({
        role: 'user',
        parts: chatContentParts(raw.content, images, diag),
        ...(typeof raw.content === 'string' ? { stringContent: true } : {}),
      });
      continue;
    }
    if (role === 'assistant') {
      const parts: IrPart[] = [];
      const reasoning =
        typeof raw.reasoning_content === 'string' && raw.reasoning_content
          ? raw.reasoning_content
          : typeof raw.reasoning === 'string' && raw.reasoning
            ? raw.reasoning
            : null;
      if (reasoning) parts.push({ type: 'thinking', text: reasoning });
      parts.push(...chatContentParts(typeof raw.content === 'string' ? raw.content : Array.isArray(raw.content) ? raw.content : '', [], diag));
      for (const tc of Array.isArray(raw.tool_calls) ? raw.tool_calls : []) {
        if (!isRecord(tc)) throw new ConversionError('conversion_not_supported: tool_calls entry is not an object');
        if (tc.type !== 'function' || !isRecord(tc.function)) {
          throw new ConversionError('conversion_not_supported: only function tool_calls are supported');
        }
        assertFields(tc, ['id', 'type', 'function'], 'tool_call');
        assertFields(tc.function, ['name', 'arguments'], 'tool_call.function');
        const id = typeof tc.id === 'string' ? tc.id : '';
        if (!id) throw new ConversionError('conversion_not_supported: tool_call id is required');
        if (typeof tc.function.name !== 'string' || !tc.function.name) {
          throw new ConversionError('conversion_not_supported: tool_call function.name is required');
        }
        if (typeof tc.function.arguments !== 'string')
          throw new ConversionError('conversion_not_supported: tool_call arguments must be a JSON string');
        // Arguments must decode to a JSON object; anything else cannot be replayed on the target.
        parseToolArguments(tc.function.arguments);
        parts.push({ type: 'tool_call', id, name: tc.function.name, args: tc.function.arguments });
      }
      request.messages.push({ role: 'assistant', parts });
      continue;
    }
    if (role === 'tool') {
      const callId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '';
      if (!callId) throw new ConversionError('conversion_not_supported: tool message missing tool_call_id');
      if (raw.is_error !== undefined && typeof raw.is_error !== 'boolean') {
        throw new ConversionError('conversion_not_supported: tool message is_error must be a boolean');
      }
      if (raw.status !== undefined && typeof raw.status !== 'string') {
        throw new ConversionError('conversion_not_supported: tool message status must be a string');
      }
      const isError = raw.is_error === true || (typeof raw.status === 'string' && raw.status !== 'success');
      const messages = request.messages;
      const images: IrImagePart[] = [];
      const text = toolMessageText(raw.content, images);
      const result: IrPart = { type: 'tool_result', callId, text, images, isError };
      messages.push({ role: 'user', parts: [result] });
      continue;
    }
    throw new ConversionError(`conversion_not_supported: role "${String(role)}"`);
  }
  if (request.messages.length === 0) throw new ConversionError('conversion_not_supported: messages array is empty');
  return { request, diag };
}

function toolMessageText(content: unknown, images: IrImagePart[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content);
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (isRecord(part) && part.type === 'text') parts.push(typeof part.text === 'string' ? part.text : '');
    else if (isRecord(part) && part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
      const image: IrImagePart = { type: 'image', url: part.image_url.url };
      images.push(image);
      parts.push('[image included in tool result]');
    } else throw new ConversionError('conversion_not_supported: non-text tool message content part');
  }
  return parts.join('\n');
}

function systemText(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') text = `${text}${text ? '\n' : ''}${part}`;
      else if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') text = `${text}${text ? '\n' : ''}${part.text}`;
      else throw new ConversionError('conversion_not_supported: system content must be text');
    }
  }
  return text;
}

function chatStop(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((s) => typeof s === 'string')) return value as string[];
  throw new ConversionError('conversion_not_supported: stop must be a string or string[]');
}

function parseChatEffort(body: Record<string, unknown>): IrEffort | null | undefined {
  if (body.reasoning_effort == null) return undefined;
  const effort = normalizeEffort(body.reasoning_effort);
  if (effort === undefined) throw new ConversionError(`conversion_not_supported: reasoning_effort "${String(body.reasoning_effort)}"`);
  return effort;
}

function chatStructuredSchema(body: Record<string, unknown>, diag: MatrixDiag): { schema: Record<string, unknown> } | null {
  if (body.response_format === undefined) return null;
  if (!isRecord(body.response_format)) throw new ConversionError('conversion_not_supported: response_format must be an object');
  assertFields(body.response_format, ['type', 'json_schema', 'name', 'description', 'strict'], 'response_format');
  if (body.response_format.type !== 'json_schema')
    throw new ConversionError('conversion_not_supported: only response_format type json_schema is supported');
  const js = body.response_format.json_schema;
  if (!isRecord(js)) throw new ConversionError('conversion_not_supported: response_format.json_schema must be an object');
  assertFields(js, ['schema', 'name', 'description', 'strict'], 'response_format.json_schema');
  if (!isRecord(js.schema)) throw new ConversionError('conversion_not_supported: response_format.json_schema.schema must be an object');
  diag.add({ feature: 'structured_output', action: 'emulated', strategy: 'prompt' });
  return { schema: js.schema };
}

// ---- Build: IR -> OpenAI Chat request body ---------------------------------

export function buildChatRequest(ir: IrRequest, diag: MatrixDiag): Record<string, unknown> {
  const out: Record<string, unknown> = { model: ir.model };
  const messages: Record<string, unknown>[] = [];
  let pendingToolResults: { callId: string; part: IrPart & { type: 'tool_result' } }[] = [];
  let pendingUserParts: Record<string, unknown>[] = [];

  const flushToolResults = () => {
    for (const r of pendingToolResults) {
      diag.add({ feature: 'tool_results', action: 'mapped' });
      if (r.part.isError) diag.add({ feature: 'tool_result_error_marker', action: 'dropped' });
      messages.push({ role: 'tool', tool_call_id: r.callId, content: r.part.text });
      for (const image of r.part.images) {
        pendingUserParts.push({ type: 'text', text: '[image attached from a tool result]' });
        pendingUserParts.push({ type: 'image_url', image_url: { url: image.url } });
      }
    }
    pendingToolResults = [];
  };
  const flushUserParts = () => {
    if (pendingUserParts.length) {
      messages.push({ role: 'user', content: pendingUserParts });
      pendingUserParts = [];
    }
  };

  const systemJoined = ir.system.join('\n');
  if (systemJoined) {
    diag.add({ feature: 'system_role', action: 'mapped' });
    messages.push({ role: 'system', content: systemJoined });
  }
  if (ir.structuredOutputSchema) {
    messages.push({ role: 'system', content: structuredOutputInstruction(ir.structuredOutputSchema) });
  }

  for (const message of ir.messages) {
    if (message.role === 'system') {
      // Legacy contract: a mid-conversation system run becomes its own plain user message.
      flushToolResults();
      flushUserParts();
      messages.push({ role: 'user', content: message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') });
      diag.add({ feature: 'mid_conversation_system', action: 'mapped' });
      continue;
    }
    if (message.role === 'user') {
      // A plain-text string user message stays a string on the wire (the legacy shape).
      const [only] = message.parts;
      if (message.stringContent && message.parts.length === 1 && only?.type === 'text' && only.text) {
        flushToolResults();
        flushUserParts();
        messages.push({ role: 'user', content: only.text });
        continue;
      }
      for (const part of message.parts) {
        if (part.type === 'tool_result') pendingToolResults.push({ callId: part.callId, part });
        else if (part.type === 'text' && part.text) {
          flushToolResults();
          pendingUserParts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          flushToolResults();
          pendingUserParts.push({ type: 'image_url', image_url: { url: imageRef(part) } });
        } else if (part.type === 'thinking') {
          diag.add({ feature: 'thinking_in_user_message', action: 'dropped' });
        }
      }
      continue;
    }
    // assistant
    flushToolResults();
    flushUserParts();
    const msg: Record<string, unknown> = { role: 'assistant', content: '' };
    let content = '';
    const toolCalls: Record<string, unknown>[] = [];
    for (const part of message.parts) {
      if (part.type === 'text') content += part.text;
      else if (part.type === 'thinking') {
        // Prior-turn reasoning is not replayed to Chat upstreams (legacy contract).
        diag.add({ feature: 'thinking_history', action: 'dropped' });
      } else if (part.type === 'tool_call') {
        diag.add({ feature: 'tool_calls', action: 'mapped' });
        toolCalls.push({ id: toolCallIdForChat(part.id), type: 'function', function: { name: part.name, arguments: ensureJsonArgs(part.args) } });
      } else if (part.type === 'image') {
        // Assistant images mimic genie outputs; Chat has no portable form.
        diag.add({ feature: 'assistant_image', action: 'dropped' });
      }
    }
    msg.content = content;
    if (toolCalls.length) msg.tool_calls = toolCalls;
    messages.push(msg);
  }
  flushToolResults();
  flushUserParts();

  out.messages = messages;
  if (ir.maxTokens != null) out.max_tokens = ir.maxTokens;
  if (ir.temperature != null) out.temperature = ir.temperature;
  if (ir.topP != null) out.top_p = ir.topP;
  if (ir.stop.length) out.stop = ir.stop.length === 1 ? ir.stop[0] : ir.stop;
  if (ir.tools.length) {
    diag.add({ feature: 'function_tools', action: 'mapped' });
    out.tools = ir.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: isRecord(tool.schema) ? tool.schema : {},
      },
    }));
  }
  if (ir.toolChoice) {
    out.tool_choice =
      ir.toolChoice === 'required' || ir.toolChoice === 'auto' || ir.toolChoice === 'none'
        ? ir.toolChoice
        : { type: 'function', function: { name: ir.toolChoice.slice('name:'.length) } };
  }
  if (ir.parallelToolCalls != null) out.parallel_tool_calls = ir.parallelToolCalls;
  if (ir.effort) {
    out.reasoning_effort = ir.effort === 'max' ? 'high' : ir.effort;
    if (ir.effort === 'max') diag.add({ feature: 'effort_control', action: 'emulated' });
  }
  return out;
}

function imageRef(part: IrPart): string {
  if (part.type !== 'image') return '';
  if (part.url) return part.url;
  return part.data ? `data:${part.mediaType || 'application/octet-stream'};base64,${part.data}` : '';
}

function ensureJsonArgs(args: string): string {
  if (!args?.trim()) return '{}';
  try {
    JSON.parse(args);
    return args;
  } catch {
    return JSON.stringify({ raw: args });
  }
}

export function chatToolId(id: unknown): string {
  if (typeof id === 'string' && id) return id;
  return `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function toolCallIdForChat(id: string): string {
  return id;
}

export function structuredOutputInstruction(schema: Record<string, unknown>): string {
  return [
    'For the final assistant text response, return only valid JSON matching this JSON Schema.',
    'Do not wrap the JSON in Markdown fences and do not add text outside the JSON value.',
    JSON.stringify(schema),
  ].join('\n');
}

// ---- Whole-object round trips ---------------------------------------------

export function chatStopToIr(reason: unknown): IrStop {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool';
    case 'content_filter':
      return 'filter';
    case 'refusal':
      return 'filter';
    default:
      return 'stop';
  }
}

export function chatStopFromIr(stop: IrStop): string {
  switch (stop) {
    case 'length':
      return 'length';
    case 'tool':
      return 'tool_calls';
    case 'filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** Assemble a full Chat completion object from IR parts (upstream replies). */
export function chatObjectToIr(data: Record<string, unknown>): { reply: IrReply; diag: MatrixDiag } {
  const diag = new MatrixDiag();
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const parts: IrPart[] = [];
  const reasoning =
    typeof message.reasoning_content === 'string' && message.reasoning_content
      ? message.reasoning_content
      : typeof message.reasoning === 'string' && message.reasoning
        ? message.reasoning
        : '';
  if (reasoning) parts.push({ type: 'thinking', text: reasoning });
  if (typeof message.content === 'string' && message.content) parts.push({ type: 'text', text: message.content });
  if (typeof message.refusal === 'string' && message.refusal) parts.push({ type: 'text', text: message.refusal });
  for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isRecord(tc)) continue;
    // Chat clients may omit `type` on a response tool call; only an explicit non-function type is dropped.
    if ((tc.type !== undefined && tc.type !== 'function') || !isRecord(tc.function)) {
      diag.add({ feature: 'tool_calls', action: 'dropped' });
      continue;
    }
    parts.push({
      type: 'tool_call',
      id: typeof tc.id === 'string' ? tc.id : chatToolId(tc.id),
      name: typeof tc.function.name === 'string' ? tc.function.name : '',
      args:
        typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(isRecord(tc.function.arguments) ? tc.function.arguments : {}),
    });
  }
  return {
    reply: {
      id: typeof data.id === 'string' ? data.id : '',
      model: typeof data.model === 'string' ? data.model : '',
      parts,
      stop: chatStopToIr(choice.finish_reason),
      rawUsage: isRecord(data.usage) ? data.usage : null,
      inputTokens: 0,
    },
    diag,
  };
}
