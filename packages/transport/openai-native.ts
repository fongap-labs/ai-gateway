function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

import type { Surface } from '../contracts/protocol.ts';

export const OPENAI_SURFACE_PATH = Object.freeze({
  chat_completions: '/v1/chat/completions',
  responses: '/v1/responses',
  images_generations: '/v1/images/generations',
});

const RESPONSES_MEANINGFUL_DELTA_TYPES = new Set([
  'response.output_text.delta',
  'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta',
  'response.function_call_arguments.delta',
  'response.refusal.delta',
]);

export function resolveOpenAIPath(surface: Surface): string {
  const path = (OPENAI_SURFACE_PATH as Record<string, string | undefined>)[surface];
  if (!path) throw new Error(`unknown OpenAI surface: ${surface}`);
  return path;
}

export function buildOpenAIHeaders(request: Request, credential: string, requestId: string): Headers {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${credential}`);
  headers.set('Content-Type', request.headers.get('content-type') || 'application/json');
  headers.set('Accept', request.headers.get('accept') || 'application/json');
  headers.set('User-Agent', 'ai-gateway');
  headers.set('Accept-Encoding', 'identity');
  headers.set('X-Request-ID', requestId);
  const idempotencyKey = request.headers.get('idempotency-key');
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey.slice(0, 256));
  return headers;
}

export function isResponsesRealOutput(json: unknown): boolean {
  if (!isRecord(json)) return false;
  const type = json.type;
  if (typeof type !== 'string') return false;
  if (RESPONSES_MEANINGFUL_DELTA_TYPES.has(type)) return typeof json.delta === 'string' && json.delta.trim().length > 0;
  if (type === 'response.output_item.done') return isOpenAIResponsesObjectMeaningful({ output: [json.item] });
  if (type === 'response.completed') return isOpenAIResponsesObjectMeaningful(json.response);
  if (type === 'response.output_text.done' || type === 'response.reasoning_text.done' || type === 'response.function_call_arguments.done') {
    const text = type === 'response.function_call_arguments.done' ? json.arguments : json.text;
    return typeof text === 'string' && text.trim().length > 0;
  }
  return false;
}

export function isOpenAIChatRealOutput(json: unknown): boolean {
  if (!isRecord(json)) return false;
  const choices = json?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  for (const c of choices) {
    const delta = c?.delta;
    if (!delta || typeof delta !== 'object') continue;
    if (typeof delta.content === 'string' && delta.content.trim().length > 0) return true;
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim().length > 0) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.some(isMeaningfulToolCall)) return true;
  }
  return false;
}

function isMeaningfulToolCall(call: unknown): boolean {
  if (!isRecord(call)) return false;
  if (typeof call.id === 'string' && call.id.trim().length > 0) return true;
  const fn = isRecord(call.function) ? call.function : null;
  return Boolean(
    fn && ((typeof fn.name === 'string' && fn.name.trim().length > 0) || (typeof fn.arguments === 'string' && fn.arguments.trim().length > 0)),
  );
}

export function isOpenAIChatRealOutputForConversion(json: unknown): boolean {
  if (!isRecord(json)) return false;
  const choices = json?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  for (const c of choices) {
    const delta = c?.delta;
    if (!delta || typeof delta !== 'object') continue;
    if (typeof delta.content === 'string' && delta.content.trim().length > 0) return true;
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim().length > 0) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.some(isMeaningfulToolCall)) return true;
  }
  return false;
}

export function isOpenAIChatCompletionMeaningful(json: unknown): boolean {
  if (!isRecord(json)) return false;
  for (const choice of Array.isArray(json.choices) ? json.choices : []) {
    const message = choice?.message;
    if (!message || typeof message !== 'object') continue;
    if (typeof message.content === 'string' && message.content.trim().length > 0) return true;
    const reasoning = message.reasoning ?? message.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim().length > 0) return true;
    if (Array.isArray(message.tool_calls) && message.tool_calls.some(isMeaningfulToolCall)) return true;
    if (typeof message.refusal === 'string' && message.refusal.trim().length > 0) return true;
  }
  return false;
}

export function isOpenAIResponsesObjectMeaningful(json: unknown): boolean {
  if (!isRecord(json)) return false;
  for (const item of Array.isArray(json.output) ? json.output : []) {
    if (
      item?.type === 'function_call' &&
      ((typeof item.name === 'string' && item.name.trim().length > 0) || (typeof item.arguments === 'string' && item.arguments.trim().length > 0))
    )
      return true;
    if (item?.type === 'refusal' && typeof item.refusal === 'string' && item.refusal.trim().length > 0) return true;
    for (const part of [...(item?.content ?? []), ...(item?.summary ?? [])]) {
      const text = part?.text ?? part?.content;
      if (typeof text === 'string' && text.trim().length > 0) return true;
      if (part?.type === 'refusal' && typeof part.refusal === 'string' && part.refusal.trim().length > 0) return true;
    }
  }
  return false;
}
