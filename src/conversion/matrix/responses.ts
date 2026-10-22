// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// OpenAI Responses side of the translation matrix: request parse/build and
// whole-object round trips. Streaming decode/encode lives in
// responses-stream.ts.

import { ConversionError } from '../validation.ts';
import { MatrixDiag } from './diag.ts';
import {
  type IrDocumentPart,
  type IrImagePart,
  type IrPart,
  type IrReply,
  type IrRequest,
  type IrStop,
  type IrTool,
  inlineDataUrlImage,
  isRecord,
  normalizeEffort,
} from './ir.ts';

export { ConversionError };

const RESPONSES_ALLOWED_FIELDS = [
  'model',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'max_output_tokens',
  'max_tool_calls',
  'parallel_tool_calls',
  'store',
  'metadata',
  'stream',
  'reasoning',
  'text',
  'truncation',
  'previous_response_id',
  'include',
  'prompt',
  'prompt_cache_key',
  'service_tier',
  'background',
] as const;

function assertFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (allowed.includes(key)) continue;
    const options = label === 'request' ? { requestField: key } : {};
    throw new ConversionError(`conversion_not_supported: unknown ${label} field "${key}"`, undefined, options);
  }
}

function responsesTools(body: Record<string, unknown>, diag: MatrixDiag): IrTool[] {
  const tools: IrTool[] = [];
  for (const rawTool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isRecord(rawTool)) throw new ConversionError('conversion_not_supported: tools entry is not an object');
    if (rawTool.type === 'custom') {
      // Codex custom tools (e.g., apply_patch) → declare as function with {"input": string} param
      const name = rawTool.name;
      if (typeof name !== 'string' || !name) continue;
      diag.add({ feature: 'custom_tool', action: 'mapped' });
      tools.push({
        name,
        description: typeof rawTool.description === 'string' ? rawTool.description : '',
        schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
      });
      continue;
    }
    if (rawTool.type !== 'function') {
      diag.add({ feature: 'provider_native_tool', action: 'dropped' });
      continue;
    }
    assertFields(rawTool, ['type', 'name', 'description', 'parameters', 'strict'], 'tool');
    if (typeof rawTool.name !== 'string' || !rawTool.name) throw new ConversionError('conversion_not_supported: tool.name is required');
    tools.push({
      name: rawTool.name,
      ...(typeof rawTool.description === 'string' ? { description: rawTool.description } : {}),
      schema: isRecord(rawTool.parameters) ? rawTool.parameters : {},
      ...(rawTool.strict === true ? { strict: true } : {}),
    });
  }
  return tools;
}

function responsesToolChoice(body: Record<string, unknown>): IrRequest['toolChoice'] {
  const raw = body.tool_choice;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    if (raw === 'auto' || raw === 'none' || raw === 'required') return raw;
    throw new ConversionError(`conversion_not_supported: tool_choice "${raw}"`);
  }
  if (!isRecord(raw)) throw new ConversionError('conversion_not_supported: tool_choice must be a string or object');
  assertFields(raw, ['type', 'name'], 'tool_choice');
  if (raw.type === 'function' && typeof raw.name === 'string' && raw.name) return `name:${raw.name}`;
  throw new ConversionError('conversion_not_supported: unsupported tool_choice object');
}

function responsesEffort(body: Record<string, unknown>, diag: MatrixDiag): IrRequest['effort'] {
  const reasoning = body.reasoning;
  if (reasoning === undefined || reasoning === null) return undefined;
  if (!isRecord(reasoning)) throw new ConversionError('conversion_not_supported: reasoning must be an object');
  assertFields(reasoning, ['effort', 'summary', 'generate_summary'], 'reasoning');
  const effort = normalizeEffort(reasoning.effort);
  if (reasoning.effort !== undefined && effort === undefined) {
    throw new ConversionError(`conversion_not_supported: reasoning.effort "${String(reasoning.effort)}"`);
  }
  if (effort === null) return null;
  return effort;
}

function responsesStructured(body: Record<string, unknown>, diag: MatrixDiag): Record<string, unknown> | null {
  const text = body.text;
  if (text === undefined || text === null) return null;
  if (!isRecord(text)) throw new ConversionError('conversion_not_supported: text must be an object');
  assertFields(text, ['format'], 'text');
  const format = text.format;
  if (format === undefined || format === null) return null;
  if (!isRecord(format)) throw new ConversionError('conversion_not_supported: text.format must be an object');
  assertFields(format, ['type', 'name', 'schema', 'strict', 'description'], 'text.format');
  if (format.type !== 'json_schema') return null;
  if (!isRecord(format.schema)) throw new ConversionError('conversion_not_supported: text.format.schema must be an object');
  diag.add({ feature: 'structured_output', action: 'emulated', strategy: 'prompt' });
  return format.schema as Record<string, unknown>;
}

type InputPartSource = { parts: IrPart[]; role: 'user' | 'assistant' | 'system' };

function inputValueToMessages(
  value: unknown,
  diag: MatrixDiag,
): { system: string; messages: { role: 'user' | 'assistant' | 'system'; parts: IrPart[] }[] } {
  if (typeof value === 'string') {
    return { system: '', messages: value ? [{ role: 'user', parts: [{ type: 'text', text: value }] }] : [] };
  }
  if (!Array.isArray(value)) throw new ConversionError('conversion_not_supported: input must be a string or array');
  let system = '';
  const messages: InputPartSource[] = [];
  const pushMessage = (role: 'user' | 'assistant' | 'system', parts: IrPart[]): void => {
    if (parts.length === 0) return;
    const tail = messages[messages.length - 1];
    if (tail && tail.role === role) tail.parts.push(...parts);
    else messages.push({ role, parts });
  };
  for (const item of value) {
    if (typeof item === 'string') {
      pushMessage('user', [{ type: 'text', text: item }]);
      continue;
    }
    if (!isRecord(item)) throw new ConversionError('conversion_not_supported: input item is not an object');
    switch (item.type) {
      case 'message': {
        assertFields(item, ['type', 'role', 'content'], 'input message');
        const role = item.role;
        if (role === 'system' || role === 'developer') {
          system = joinSystemText(system, item.content, diag);
          continue;
        }
        if (role === 'user') pushMessage('user', inputContentParts(item.content, diag));
        else if (role === 'assistant') pushMessage('assistant', outputContentParts(item.content, diag));
        else throw new ConversionError(`conversion_not_supported: input message role "${String(role)}"`);
        continue;
      }
      case 'function_call': {
        assertFields(item, ['type', 'call_id', 'name', 'arguments', 'id'], 'function_call');
        if (typeof item.name !== 'string' || !item.name) throw new ConversionError('conversion_not_supported: function_call.name is required');
        pushMessage('assistant', [
          {
            type: 'tool_call',
            id:
              typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${typeof item.id === 'string' ? item.id : crypto.randomUUID()}`,
            name: item.name,
            args: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(isRecord(item.arguments) ? item.arguments : {}),
          },
        ]);
        continue;
      }
      case 'function_call_output': {
        assertFields(item, ['type', 'call_id', 'output', 'id'], 'function_call_output');
        if (typeof item.call_id !== 'string' || !item.call_id)
          throw new ConversionError('conversion_not_supported: function_call_output.call_id is required');
        pushMessage('user', [{ type: 'tool_result', callId: item.call_id, text: functionCallOutputToText(item.output, diag), images: [] }]);
        continue;
      }
      case 'reasoning': {
        assertFields(item, ['type', 'summary', 'content', 'encrypted_content', 'id'], 'reasoning item');
        const parts: IrPart[] = [];
        for (const summary of Array.isArray(item.summary) ? item.summary : []) {
          if (isRecord(summary) && summary.type === 'summary_text' && typeof summary.text === 'string')
            parts.push({ type: 'thinking', text: summary.text });
        }
        for (const block of Array.isArray(item.content) ? item.content : []) {
          if (isRecord(block) && block.type === 'reasoning_text' && typeof block.text === 'string')
            parts.push({ type: 'thinking', text: block.text });
        }
        if (typeof item.encrypted_content === 'string' && item.encrypted_content) {
          diag.add({ feature: 'thinking_history', action: 'dropped' });
          parts.push({ type: 'thinking', text: '', sealed: true, data: item.encrypted_content });
        }
        if (parts.length === 0) diag.add({ feature: 'thinking_history', action: 'dropped' });
        pushMessage('assistant', parts);
        continue;
      }
      case 'custom_tool_call': {
        assertFields(item, ['type', 'call_id', 'name', 'input', 'id'], 'custom_tool_call');
        if (typeof item.name !== 'string' || !item.name) throw new ConversionError('conversion_not_supported: custom_tool_call.name is required');
        pushMessage('assistant', [
          {
            type: 'tool_call',
            id:
              typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${typeof item.id === 'string' ? item.id : crypto.randomUUID()}`,
            name: item.name,
            args: JSON.stringify({ input: item.input }),
          },
        ]);
        continue;
      }
      case 'custom_tool_call_output': {
        assertFields(item, ['type', 'call_id', 'output', 'id'], 'custom_tool_call_output');
        if (typeof item.call_id !== 'string' || !item.call_id)
          throw new ConversionError('conversion_not_supported: custom_tool_call_output.call_id is required');
        pushMessage('user', [{ type: 'tool_result', callId: item.call_id, text: functionCallOutputToText(item.output, diag), images: [] }]);
        continue;
      }
      case 'local_shell_call': {
        const action = item.action;
        const text = action ? `[local_shell] ${JSON.stringify(action)}` : '[local_shell]';
        pushMessage('assistant', [{ type: 'text', text }]);
        continue;
      }
      case 'local_shell_call_output': {
        const output = item.output;
        const text = typeof output === 'string' ? output : JSON.stringify(output);
        pushMessage('user', [{ type: 'text', text: `[local_shell output] ${text}` }]);
        continue;
      }
      default:
        diag.add({ feature: 'unknown_input_item', action: 'dropped' });
    }
  }
  return { system, messages };
}

function joinSystemText(existing: string, content: unknown, diag: MatrixDiag): string {
  if (existing) diag.add({ feature: 'system_role', action: 'mapped' });
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') text = `${text}${text ? '\n' : ''}${block}`;
      else if (isRecord(block) && block.type === 'input_text' && typeof block.text === 'string') text = `${text}${text ? '\n' : ''}${block.text}`;
      else if (isRecord(block) && block.type === 'output_text' && typeof block.text === 'string') text = `${text}${text ? '\n' : ''}${block.text}`;
      else throw new ConversionError('conversion_not_supported: system content must be text');
    }
  }
  return existing ? `${existing}\n${text}` : text;
}

function inputContentParts(content: unknown, diag: MatrixDiag): IrPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new ConversionError('conversion_not_supported: invalid user content');
  const parts: IrPart[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push({ type: 'text', text: block });
      continue;
    }
    if (!isRecord(block)) throw new ConversionError('conversion_not_supported: invalid user content block');
    if (block.type === 'input_text') {
      if (typeof block.text !== 'string') throw new ConversionError('conversion_not_supported: invalid input_text');
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'input_image') {
      assertFields(block, ['type', 'image_url', 'detail'], 'input_image');
      const url = typeof block.image_url === 'string' ? block.image_url : '';
      if (!url) throw new ConversionError('conversion_not_supported: input_image.image_url is required');
      parts.push(inlineDataUrlImage(url));
      continue;
    }
    throw new ConversionError(`conversion_not_supported: user content type "${String(block.type)}"`);
  }
  return parts;
}

function outputContentParts(content: unknown, diag: MatrixDiag): IrPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new ConversionError('conversion_not_supported: invalid assistant content');
  const parts: IrPart[] = [];
  for (const block of content) {
    if (!isRecord(block)) throw new ConversionError('conversion_not_supported: invalid assistant content block');
    if (block.type === 'output_text') {
      if (typeof block.text !== 'string') throw new ConversionError('conversion_not_supported: invalid output_text');
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'refusal') {
      if (typeof block.refusal !== 'string') throw new ConversionError('conversion_not_supported: invalid refusal');
      parts.push({ type: 'text', text: block.refusal });
      continue;
    }
    throw new ConversionError(`conversion_not_supported: assistant content type "${String(block.type)}"`);
  }
  return parts;
}

function functionCallOutputToText(output: unknown, diag: MatrixDiag): string {
  if (typeof output === 'string') return output;
  if (isRecord(output) && Array.isArray(output.content)) {
    const texts: string[] = [];
    for (const part of output.content) {
      if (typeof part === 'string') texts.push(part);
      else if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
      else diag.add({ feature: 'tool_results', action: 'dropped' });
    }
    return texts.join('\n');
  }
  if (output === undefined || output === null) return '';
  return JSON.stringify(output);
}

/** Parse an OpenAI Responses request body into the canonical IR. */
export function parseResponsesRequest(body: Record<string, unknown>): { request: IrRequest; diag: MatrixDiag } {
  if (!isRecord(body)) throw new ConversionError('conversion_not_supported: request body is not an object');
  assertFields(body, RESPONSES_ALLOWED_FIELDS, 'request');
  const diag = new MatrixDiag();
  if (body.metadata !== undefined) diag.add({ feature: 'metadata', action: 'dropped' });
  for (const field of [
    'max_tool_calls',
    'truncation',
    'previous_response_id',
    'include',
    'prompt',
    'prompt_cache_key',
    'service_tier',
    'background',
    'store',
  ] as const) {
    if (body[field] !== undefined) diag.add({ feature: 'responses_extras', action: 'dropped' });
  }
  const effort = responsesEffort(body, diag);
  const structured = responsesStructured(body, diag);
  const { system, messages } = inputValueToMessages(body.input, diag);
  const instructions = typeof body.instructions === 'string' ? body.instructions : '';
  if (instructions) diag.add({ feature: 'system_role', action: 'mapped' });
  const joinedSystem = instructions && system ? `${instructions}\n${system}` : instructions || system;
  const request: IrRequest = {
    model: typeof body.model === 'string' && body.model.trim() ? body.model : '',
    system: joinedSystem ? [joinedSystem] : [],
    messages,
    tools: responsesTools(body, diag),
    toolChoice: responsesToolChoice(body),
    maxTokens: Number.isFinite(body.max_output_tokens) ? Number(body.max_output_tokens) : null,
    temperature: typeof body.temperature === 'number' ? body.temperature : null,
    topP: typeof body.top_p === 'number' ? body.top_p : null,
    stop: [],
    ...(effort === undefined ? {} : { effort }),
    ...(structured ? { structuredOutputSchema: structured } : {}),
    ...(typeof body.parallel_tool_calls === 'boolean' ? { parallelToolCalls: body.parallel_tool_calls } : {}),
  };
  if (!request.model) throw new ConversionError('conversion_not_supported: model is required');
  if (messages.length === 0 && request.system.length === 0) throw new ConversionError('conversion_not_supported: input is empty');
  return { request, diag };
}

// ---- Build: IR -> OpenAI Responses request body ----------------------------

export function buildResponsesRequest(ir: IrRequest, diag: MatrixDiag): Record<string, unknown> {
  const out: Record<string, unknown> = { model: ir.model };
  const instructions = ir.system.join('\n');
  if (instructions) out.instructions = instructions;
  const input: Record<string, unknown>[] = [];
  for (const message of ir.messages) {
    if (message.role === 'system') {
      input.push({
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') }],
      });
      continue;
    }
    if (message.role === 'user') {
      const content: Record<string, unknown>[] = [];
      const pendingImages: IrImagePart[] = [];
      const pendingDocuments: IrDocumentPart[] = [];
      const flushContent = () => {
        if (content.length) {
          input.push({ type: 'message', role: 'user', content: [...content] });
          content.length = 0;
        }
      };
      const flushImages = () => {
        if (pendingImages.length || pendingDocuments.length) {
          input.push({
            type: 'message',
            role: 'user',
            content: [
              ...pendingImages.map((image) => ({ type: 'input_image', image_url: imageUrlOf(image) })),
              ...pendingDocuments.map(inputFilePart),
            ],
          });
          pendingImages.length = 0;
          pendingDocuments.length = 0;
        }
      };
      for (const part of message.parts) {
        if (part.type === 'text') {
          flushContent();
          flushImages();
          content.push({ type: 'input_text', text: part.text });
          continue;
        }
        if (part.type === 'image') {
          content.push({ type: 'input_image', image_url: imageUrlOf(part) });
          continue;
        }
        if (part.type === 'document') {
          content.push(inputFilePart(part));
          continue;
        }
        if (part.type === 'tool_result') {
          diag.add({ feature: 'tool_results', action: 'mapped' });
          if (part.isError) diag.add({ feature: 'tool_result_error_marker', action: 'dropped' });
          flushContent();
          input.push({ type: 'function_call_output', call_id: part.callId, output: part.text });
          for (const image of part.images) pendingImages.push(image);
          for (const document of part.documents ?? []) pendingDocuments.push(document);
          continue;
        }
        diag.add({ feature: 'thinking_history', action: 'dropped' });
      }
      flushContent();
      flushImages();
      continue;
    }
    // assistant
    const content: Record<string, unknown>[] = [];
    for (const part of message.parts) {
      if (part.type === 'text') {
        if (part.text) content.push({ type: 'output_text', text: part.text });
        continue;
      }
      if (part.type === 'thinking') {
        if (part.text) {
          diag.add({ feature: 'thinking_history', action: 'mapped' });
          input.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: part.text }] });
        } else if (part.sealed) diag.add({ feature: 'thinking_history', action: 'dropped' });
        continue;
      }
      if (part.type === 'tool_call') {
        diag.add({ feature: 'tool_calls', action: 'mapped' });
        input.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: part.args });
        continue;
      }
      diag.add({ feature: 'assistant_image', action: 'dropped' });
    }
    if (content.length) input.push({ type: 'message', role: 'assistant', content });
  }
  if (input.length === 0 && !out.instructions) throw new ConversionError('conversion_not_supported: translated conversation is empty');
  out.input = input;

  if (ir.structuredOutputSchema) {
    out.text = { format: { type: 'json_schema', name: 'response', schema: ir.structuredOutputSchema, strict: true } };
  }
  let maxTokens = ir.maxTokens;
  if (maxTokens == null) {
    maxTokens = RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS;
    diag.add({ feature: 'max_tokens', action: 'defaulted' });
  }
  out.max_output_tokens = maxTokens;
  if (ir.temperature != null) out.temperature = ir.temperature;
  if (ir.topP != null) out.top_p = ir.topP;
  // top_k is an Anthropic-native control; this target cannot carry it.
  if (ir.topK != null) diag.add({ feature: 'sampling_control', action: 'dropped' });
  if (ir.stop.length) diag.add({ feature: 'stop_sequences', action: 'dropped' });
  if (ir.tools.length) {
    diag.add({ feature: 'function_tools', action: 'mapped' });
    out.tools = ir.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: isRecord(tool.schema) ? tool.schema : {},
      ...(tool.strict === true ? { strict: true } : {}),
    }));
  }
  if (ir.toolChoice) {
    out.tool_choice =
      ir.toolChoice === 'required' || ir.toolChoice === 'auto' || ir.toolChoice === 'none'
        ? ir.toolChoice
        : { type: 'function', name: ir.toolChoice.slice('name:'.length) };
  }
  if (ir.parallelToolCalls != null) out.parallel_tool_calls = ir.parallelToolCalls;
  if (ir.effort) {
    diag.add({ feature: 'reasoning_control', action: 'mapped' });
    out.reasoning = { effort: ir.effort === 'max' ? 'high' : ir.effort, summary: 'auto' };
    if (ir.effort === 'max') diag.add({ feature: 'effort_control', action: 'emulated' });
  }
  return out;
}

export const RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS = 1024;

function inputFilePart(part: IrDocumentPart): Record<string, unknown> {
  return { type: 'input_file', ...(part.filename ? { filename: part.filename } : {}), file_data: `data:${part.mediaType};base64,${part.data}` };
}

function imageUrlOf(part: IrImagePart): string {
  if (part.url) return part.url;
  return part.data ? `data:${part.mediaType || 'application/octet-stream'};base64,${part.data}` : '';
}

// ---- Whole-object round trips ---------------------------------------------

export function responsesStopToIr(status: unknown, hasToolCalls: boolean): IrStop {
  if (status === 'incomplete') return 'length';
  if (status === 'failed') return 'filter';
  if (hasToolCalls) return 'tool';
  return 'stop';
}

/** Assemble a Responses response object into IR (upstream replies). */
export function responsesObjectToIr(data: Record<string, unknown>): { reply: IrReply; diag: MatrixDiag } {
  const diag = new MatrixDiag();
  const parts: IrPart[] = [];
  let hasToolCalls = false;
  for (const item of Array.isArray(data.output) ? data.output : []) {
    if (!isRecord(item)) continue;
    if (item.type === 'message') {
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (isRecord(block) && block.type === 'output_text' && typeof block.text === 'string' && block.text)
          parts.push({ type: 'text', text: block.text });
        else if (isRecord(block) && block.type === 'refusal' && typeof block.refusal === 'string' && block.refusal)
          parts.push({ type: 'text', text: block.refusal });
      }
      continue;
    }
    if (item.type === 'reasoning') {
      for (const summary of Array.isArray(item.summary) ? item.summary : []) {
        if (isRecord(summary) && summary.type === 'summary_text' && typeof summary.text === 'string' && summary.text)
          parts.push({ type: 'thinking', text: summary.text });
      }
      if (typeof item.encrypted_content === 'string' && item.encrypted_content) {
        diag.add({ feature: 'thinking_history', action: 'dropped' });
        parts.push({ type: 'thinking', text: '', sealed: true, data: item.encrypted_content });
      }
      continue;
    }
    if (item.type === 'function_call') {
      hasToolCalls = true;
      parts.push({
        type: 'tool_call',
        id: typeof item.call_id === 'string' ? item.call_id : '',
        name: typeof item.name === 'string' ? item.name : '',
        args: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(isRecord(item.arguments) ? item.arguments : {}),
      });
      continue;
    }
    diag.add({ feature: 'response_content_type', action: 'dropped' });
  }
  const status = data.status;
  return {
    reply: {
      id: typeof data.id === 'string' ? data.id : '',
      model: typeof data.model === 'string' ? data.model : '',
      parts,
      stop: responsesStopToIr(status, hasToolCalls),
      rawUsage: isRecord(data.usage) ? data.usage : null,
      inputTokens: 0,
    },
    diag,
  };
}
