// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Google Code Assist subscription wire conversion.
//
// The Google One AI Premium / Gemini subscription entitlement is served by
// the Cloud Code Assist backend (cloudcode-pa.googleapis.com/v1internal),
// which speaks a proprietary wire: a GenerateContent request envelope
// {model, project?, request:{contents, systemInstruction, generationConfig,
// tools?}} and a GenerateContentResponse {candidates, usageMetadata}. It is
// NOT OpenAI Chat Completions.
//
// This module owns the pure, fail-closed conversion between the OpenAI Chat
// Completions shape (the gateway's client-facing surface for google nodes)
// and the Code Assist envelope, in both directions and for both object and
// streaming responses. It is composed into the google subscription adapter;
// the gateway's transport/conversion layers are untouched (the Code Assist
// wire is a subscription-owned proprietary wire, not a third protocol family).
//
// Conversion is intentionally conservative: an unsupported request part, an
// unknown role, or an unparseable tool payload returns null so the dispatch
// rotates the node instead of sending a half-shaped request upstream.
// Generation-only fields with no Gemini equivalent (frequency_penalty,
// presence_penalty, logprobs, n, user) are dropped by documented design;
// the gateway never invents a fake mapping for them.

import { createSseScanner } from '../stream/guard.ts';

// ---- Constants (public OAuth/client constants from the open-source Gemini CLI) ----

export const GEMINI_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const GEMINI_CLI_USER_AGENT = 'GeminiCLI/v0.60.0 (linux; x64)';

export const CODE_ASSIST_PATH = Object.freeze({
  stream: '/v1internal:streamGenerateContent?alt=sse',
  object: '/v1internal:generateContent',
});

// ---- Request: OpenAI Chat -> Code Assist envelope -----------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNonNegativeInt(value: unknown): number | null {
  const n = asNumber(value);
  return n !== null && n >= 0 && Number.isInteger(n) ? n : null;
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  let out = '';
  for (const part of content) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    if (!isRecord(part)) return null;
    if (part.type === 'text' || part.type === 'output_text') {
      if (typeof part.text !== 'string') return null;
      out += part.text;
      continue;
    }
    return null;
  }
  return out;
}

function buildGenerationConfig(body: Record<string, unknown>): Record<string, unknown> | null {
  const cfg: Record<string, unknown> = {};
  const maxTokens = asNonNegativeInt(body.max_tokens) ?? asNonNegativeInt(body.max_completion_tokens);
  if (maxTokens !== null) cfg.maxOutputTokens = maxTokens;
  const temperature = asNumber(body.temperature);
  if (temperature !== null) cfg.temperature = temperature;
  const topP = asNumber(body.top_p);
  if (topP !== null) cfg.topP = topP;
  const stop = body.stop;
  if (typeof stop === 'string') cfg.stopSequences = [stop];
  else if (Array.isArray(stop) && stop.every((s) => typeof s === 'string') && stop.length > 0) {
    cfg.stopSequences = stop as string[];
  }
  const seed = asNumber(body.seed);
  if (seed !== null && Number.isInteger(seed)) cfg.seed = seed;
  const format = body.response_format;
  if (isRecord(format) && format.type === 'json_object') {
    cfg.responseMimeType = 'application/json';
  } else if (isRecord(format) && format.type === 'json_schema' && isRecord(format.json_schema) && isRecord(format.json_schema.schema)) {
    cfg.responseMimeType = 'application/json';
    cfg.responseSchema = format.json_schema.schema;
  }
  return Object.keys(cfg).length === 0 ? null : cfg;
}

/** Build Gemini tools from OpenAI tool definitions.
 *  - absent/empty -> {tools: null} (no tools in the request)
 *  - supported -> {tools: [...]}
 *  - unsupported (non-function tool, malformed function) -> {unsupported: true}
 *  Unsupported tools refuse the whole request (fail-closed) instead of being
 *  silently dropped, because the client expects them to be callable. */
function buildTools(tools: unknown): { tools: Record<string, unknown>[] | null; unsupported?: false } | { unsupported: true } {
  if (tools === undefined || tools === null) return { tools: null };
  if (!Array.isArray(tools) || tools.length === 0) return { tools: null };
  const declarations: Record<string, unknown>[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) return { unsupported: true };
    const type = tool.type === undefined ? 'function' : tool.type;
    if (type !== 'function') return { unsupported: true };
    const fn = tool.function;
    if (!isRecord(fn)) return { unsupported: true };
    if (typeof fn.name !== 'string' || !fn.name.trim()) return { unsupported: true };
    const decl: Record<string, unknown> = { name: fn.name };
    if (typeof fn.description === 'string' && fn.description) decl.description = fn.description;
    if (fn.parameters === undefined) decl.parameters = {};
    else if (isRecord(fn.parameters)) decl.parameters = fn.parameters;
    else return { unsupported: true };
    declarations.push(decl);
  }
  return { tools: [{ functionDeclarations: declarations }] };
}

/** Map OpenAI tool_choice to a Gemini toolConfig.
 *  - absent/null -> null (omit toolConfig)
 *  - supported -> a toolConfig object
 *  - unrecognized -> false (refuse the request; fail-closed) */
function buildToolConfig(toolChoice: unknown): Record<string, unknown> | null | false {
  if (toolChoice === undefined || toolChoice === null) return null;
  if (toolChoice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (toolChoice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  if (isRecord(toolChoice) && toolChoice.type === 'function' && isRecord(toolChoice.function) && typeof toolChoice.function.name === 'string') {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.function.name] } };
  }
  return false;
}

function parseDataImageUrl(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { mimeType: m[1], data: m[2] };
}

function parseJsonArgs(args: string): unknown | null {
  if (args === '' || args === undefined) return {};
  if (typeof args !== 'string') return null;
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}

type MessageResult =
  | { tag: 'system'; text: string }
  | { tag: 'content'; content: Record<string, unknown> }
  | { tag: 'skip' }
  | { tag: 'unsupported'; reason: string };

function convertMessage(message: unknown, toolCallNames: Map<string, string>): MessageResult {
  if (!isRecord(message)) return { tag: 'unsupported', reason: 'message is not an object' };
  const role = message.role;
  if (role === 'system' || role === 'developer') {
    const text = extractText(message.content);
    if (text === null) return { tag: 'unsupported', reason: 'system content' };
    return { tag: 'system', text };
  }
  if (role === 'user') {
    const parts = buildUserParts(message.content);
    if (parts === null) return { tag: 'unsupported', reason: 'user content' };
    if (parts.length === 0) return { tag: 'skip' };
    return { tag: 'content', content: { role: 'user', parts } };
  }
  if (role === 'assistant') {
    const text = extractText(message.content);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const parts: Record<string, unknown>[] = [];
    if (text !== null && text !== '') parts.push({ text });
    for (const call of toolCalls) {
      if (!isRecord(call)) return { tag: 'unsupported', reason: 'tool_call' };
      const fn = call.function;
      if (!isRecord(fn) || typeof fn.name !== 'string' || typeof call.id !== 'string') {
        return { tag: 'unsupported', reason: 'tool_call id/name' };
      }
      const args = parseJsonArgs(typeof fn.arguments === 'string' ? fn.arguments : '');
      if (args === null) return { tag: 'unsupported', reason: 'tool_call arguments' };
      toolCallNames.set(call.id, fn.name);
      parts.push({ functionCall: { name: fn.name, args } });
    }
    if (typeof message.refusal === 'string' && message.refusal) parts.push({ text: message.refusal });
    if (parts.length === 0) return { tag: 'skip' };
    return { tag: 'content', content: { role: 'model', parts } };
  }
  if (role === 'tool') {
    if (typeof message.tool_call_id !== 'string') return { tag: 'unsupported', reason: 'tool tool_call_id' };
    const name = toolCallNames.get(message.tool_call_id);
    if (!name) return { tag: 'unsupported', reason: 'tool_call_id without a preceding assistant tool_call' };
    const raw = extractText(message.content);
    if (raw === null) return { tag: 'unsupported', reason: 'tool content' };
    let response: unknown;
    try {
      response = JSON.parse(raw);
    } catch {
      response = { output: raw };
    }
    return { tag: 'content', content: { role: 'user', parts: [{ functionResponse: { name, response } }] } };
  }
  return { tag: 'unsupported', reason: `unknown role ${String(role)}` };
}

function buildUserParts(content: unknown): Record<string, unknown>[] | null {
  if (typeof content === 'string') return content === '' ? [] : [{ text: content }];
  if (!Array.isArray(content)) return null;
  const parts: Record<string, unknown>[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) parts.push({ text: part });
      continue;
    }
    if (!isRecord(part)) return null;
    if (part.type === 'text' || part.type === 'output_text') {
      if (typeof part.text !== 'string') return null;
      if (part.text) parts.push({ text: part.text });
      continue;
    }
    if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
      const img = parseDataImageUrl(part.image_url.url);
      if (!img) return null;
      parts.push({ inlineData: img });
      continue;
    }
    return null;
  }
  return parts;
}

export type CodeAssistEnvelope = { envelope: Record<string, unknown>; streaming: boolean };

/** Build the Code Assist request envelope from an OpenAI Chat body, or null
 *  when the body cannot be converted (fail-closed). `stream` is read from the
 *  body so the adapter can select the streaming vs non-streaming endpoint. */
export function openAIChatToCodeAssistEnvelope(body: Record<string, unknown> | null | undefined): CodeAssistEnvelope | null {
  if (!isRecord(body)) return null;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
  const contents: Record<string, unknown>[] = [];
  const systemParts: Record<string, unknown>[] = [];
  const toolCallNames = new Map<string, string>();
  for (const message of body.messages) {
    const result = convertMessage(message, toolCallNames);
    switch (result.tag) {
      case 'system':
        if (result.text) systemParts.push({ text: result.text });
        break;
      case 'content':
        contents.push(result.content);
        break;
      case 'skip':
        break;
      case 'unsupported':
        return null;
    }
  }
  if (contents.length === 0) return null;
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
  if (!model) return null;
  const request: Record<string, unknown> = { contents };
  if (systemParts.length > 0) request.systemInstruction = { parts: systemParts };
  const generationConfig = buildGenerationConfig(body);
  if (generationConfig) request.generationConfig = generationConfig;
  const toolsResult = buildTools(body.tools);
  if ('unsupported' in toolsResult && toolsResult.unsupported) return null;
  if (toolsResult.tools) request.tools = toolsResult.tools;
  const toolConfig = buildToolConfig(body.tool_choice);
  if (toolConfig === false) return null;
  if (toolConfig) request.toolConfig = toolConfig;
  const envelope: Record<string, unknown> = { model, request };
  return { envelope, streaming: body.stream === true };
}

// ---- Response: Code Assist -> OpenAI Chat (non-streaming) --------------------

function mapFinishReason(reason: unknown): string {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function convertUsageMetadata(usage: unknown): Record<string, unknown> | null {
  if (!isRecord(usage)) return null;
  const prompt = asNonNegativeInt(usage.promptTokenCount);
  const completion = asNonNegativeInt(usage.candidatesTokenCount) ?? asNonNegativeInt(usage.totalTokenCount) ?? 0;
  const total = asNonNegativeInt(usage.totalTokenCount) ?? (prompt ?? 0) + completion;
  if (prompt === null && total === null) return null;
  const out: Record<string, unknown> = {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion,
    total_tokens: total ?? 0,
  };
  const cached = asNonNegativeInt(usage.cachedContentTokenCount);
  if (cached !== null) out.prompt_tokens_details = { cached_tokens: cached };
  return out;
}

function buildToolCallsFromParts(parts: unknown[]): Record<string, unknown>[] | null {
  const calls: Record<string, unknown>[] = [];
  let index = 0;
  for (const part of parts) {
    if (!isRecord(part) || !isRecord(part.functionCall)) continue;
    const name = part.functionCall.name;
    if (typeof name !== 'string') return null;
    const args = part.functionCall.args;
    const argumentsString = args === undefined ? '{}' : JSON.stringify(args);
    calls.push({
      id: `call_${index}`,
      type: 'function',
      function: { name, arguments: argumentsString },
    });
    index++;
  }
  return calls;
}

/** Convert one Code Assist GenerateContentResponse object into an OpenAI
 *  Chat completion object, or null when it carries no meaningful output. */
export function codeAssistObjectToOpenAIChat(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  const candidates = data.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const candidate = candidates[0];
  if (!isRecord(candidate)) return null;
  const content = isRecord(candidate.content) ? candidate.content : null;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  let text = '';
  let hasFunctionCall = false;
  for (const part of parts) {
    if (isRecord(part) && typeof part.text === 'string') text += part.text;
    else if (isRecord(part) && isRecord(part.functionCall)) hasFunctionCall = true;
  }
  if (text === '' && !hasFunctionCall) return null;
  const message: Record<string, unknown> = { role: 'assistant', content: text === '' ? null : text };
  if (hasFunctionCall) {
    const toolCalls = buildToolCallsFromParts(parts);
    if (toolCalls === null) return null;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
  }
  const choice: Record<string, unknown> = {
    index: typeof candidate.index === 'number' ? candidate.index : 0,
    message,
    finish_reason: mapFinishReason(candidate.finishReason),
  };
  const result: Record<string, unknown> = {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof data.modelVersion === 'string' ? data.modelVersion : '',
    choices: [choice],
  };
  const usage = convertUsageMetadata(data.usageMetadata);
  if (usage) result.usage = usage;
  return result;
}

// ---- Response: Code Assist SSE -> OpenAI Chat SSE -----------------------------

type StreamState = {
  messageId: string;
  model: string;
  roleEmitted: boolean;
  finishReason: string | null;
  toolCallIndex: number;
  emittedAny: boolean;
  closed: boolean;
};

function createState(messageId: string, model: string): StreamState {
  return {
    messageId,
    model,
    roleEmitted: false,
    finishReason: null,
    toolCallIndex: 0,
    emittedAny: false,
    closed: false,
  };
}

function emitChunk(controller: ReadableStreamDefaultController<Uint8Array>, chunk: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify(chunk)}\n\n`;
  controller.enqueue(new TextEncoder().encode(payload));
}

function emitRoleHeader(state: StreamState, controller: ReadableStreamDefaultController<Uint8Array>): void {
  if (state.roleEmitted) return;
  state.roleEmitted = true;
  emitChunk(controller, {
    id: state.messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
}

function processCodeAssistChunk(state: StreamState, controller: ReadableStreamDefaultController<Uint8Array>, chunk: unknown): void {
  if (state.closed) return;
  if (!isRecord(chunk)) return;
  const candidates = chunk.candidates;
  if (Array.isArray(candidates)) {
    const candidate = candidates[0];
    if (isRecord(candidate)) {
      const content = isRecord(candidate.content) ? candidate.content : null;
      const parts = content && Array.isArray(content.parts) ? content.parts : [];
      for (const part of parts) {
        if (!isRecord(part)) continue;
        if (typeof part.text === 'string' && part.text) {
          emitRoleHeader(state, controller);
          state.emittedAny = true;
          emitChunk(controller, {
            id: state.messageId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: state.model,
            choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
          });
        } else if (isRecord(part.functionCall) && typeof part.functionCall.name === 'string') {
          emitRoleHeader(state, controller);
          state.emittedAny = true;
          const id = `call_${state.toolCallIndex++}`;
          const args = part.functionCall.args;
          emitChunk(controller, {
            id: state.messageId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: state.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: state.toolCallIndex - 1,
                      id,
                      type: 'function',
                      function: {
                        name: part.functionCall.name,
                        arguments: args === undefined ? '{}' : JSON.stringify(args),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }
      }
      if (typeof candidate.finishReason === 'string') {
        state.finishReason = mapFinishReason(candidate.finishReason);
      }
    }
  }
}

function emitFinishAndDone(state: StreamState, controller: ReadableStreamDefaultController<Uint8Array>, usage: unknown): void {
  if (state.closed) return;
  state.closed = true;
  emitChunk(controller, {
    id: state.messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta: {}, finish_reason: state.finishReason ?? 'stop' }],
  });
  const converted = convertUsageMetadata(usage);
  if (converted) {
    emitChunk(controller, {
      id: state.messageId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [],
      usage: converted,
    });
  }
  controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
}

/** Build an OpenAI Chat Completions SSE stream from a Code Assist SSE stream.
 *  Real-time conversion — no buffering of the full response. The upstream
 *  stream has no terminal event, so the converter finalizes (finish chunk +
 *  usage + `[DONE]`) when the upstream body ends cleanly. */
export function createOpenAIChatStreamFromCodeAssist(
  body: ReadableStream<Uint8Array> | null | undefined,
  options: { messageId: string; model: string },
): ReadableStream<Uint8Array> {
  const state = createState(options.messageId || `chatcmpl-${Date.now().toString(36)}`, options.model || '');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  let lastUsage: unknown = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!body) {
        controller.error(new Error('Upstream stream body is not readable'));
        return;
      }
      reader = body.getReader();
      const upstream = reader;
      const decoder = new TextDecoder();
      const scanner = createSseScanner((data) => {
        if (cancelled || state.closed) return;
        if (!data) return;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        if (isRecord(event) && isRecord(event.usageMetadata)) lastUsage = event.usageMetadata;
        processCodeAssistChunk(state, controller, event);
      });
      void (async () => {
        try {
          while (!cancelled && !state.closed) {
            const { done, value } = await upstream.read();
            if (cancelled) return;
            if (done) {
              scanner.push(decoder.decode());
              scanner.flush();
              break;
            }
            scanner.push(decoder.decode(value, { stream: true }));
          }
          if (cancelled) return;
          emitFinishAndDone(state, controller, lastUsage);
          controller.close();
        } catch (error) {
          if (!cancelled) controller.error(error);
        } finally {
          await upstream.cancel().catch(() => {});
          upstream.releaseLock();
        }
      })();
    },
    cancel(reason) {
      cancelled = true;
      return reader?.cancel(reason).catch(() => {});
    },
  });
}
