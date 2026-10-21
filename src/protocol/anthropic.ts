// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Anthropic Messages surface: request validation, error responses, and the
// local /v1/messages/count_tokens approximation.

import { corsHeaders, shouldNotRetryHeaders } from './http.ts';

export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'overloaded_error'
  | 'api_error';

export function anthropicErrorTypeForStatus(status: number): AnthropicErrorType {
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  return 'api_error';
}

export function anthropicErrorResponse(
  request: Request,
  env: Record<string, unknown>,
  status: number,
  message: unknown,
  requestId?: string,
  extraHeaders?: Record<string, string>,
): Response {
  const error = { type: anthropicErrorTypeForStatus(status), message: String(message || 'Unknown gateway error.') };
  return new Response(JSON.stringify({ type: 'error', error }), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'request-id': requestId || '',
      'x-request-id': requestId || '',
      ...corsHeaders(request, env),
      ...shouldNotRetryHeaders(status),
      ...(extraHeaders || {}),
    },
  });
}

export function validateAnthropicMessagesRequest(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  const b = body as Record<string, unknown>;
  if (!b.model || typeof b.model !== 'string') return 'model is required and must be a string.';
  if (!Number.isFinite(Number(b.max_tokens)) || Number(b.max_tokens) <= 0) return 'max_tokens is required and must be greater than 0.';
  if (!Array.isArray(b.messages)) return 'messages is required and must be an array.';
  return null;
}

export function validateAnthropicCountTokensRequest(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  const b = body as Record<string, unknown>;
  if (!b.model || typeof b.model !== 'string' || !b.model.trim()) return 'model is required and must be a non-empty string.';
  if (!Array.isArray(b.messages)) return 'messages is required and must be an array.';
  return null;
}

// Script-aware conservative token estimation for /v1/messages/count_tokens.
// A plain "chars / 4" rule badly under-counts CJK text (~1 token per Han
// character) and dense JSON tool schemas. This estimator is deliberately
// biased HIGH (over-estimating a context is safer than truncating it):
//   ASCII/Latin      ~ 4 chars per token
//   CJK / Kana       ~ 1 token per character
//   tools JSON       ~ 3 chars per token + fixed per-tool overhead
//   image blocks     fixed conservative allowance (~1600 tokens)
// The result is an APPROXIMATION, not a tokenizer.
function estimateTextTokens(text: unknown): number {
  const value = String(text || '');
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Keep astral characters counted once, as the previous for-of loop did.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        other++;
        i++;
        continue;
      }
    }
    if (
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x2e80 && code <= 0x31ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa960 && code <= 0xa97f) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff66 && code <= 0xff9f)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return cjk + other / 4;
}

// Exact JSON.stringify() length for JSON-safe values, without allocating the
// serialized copy. Tool schemas can be large (MCP), and only their length is
// needed for the dense-JSON token charge.
function jsonStringLength(value: string): number {
  let length = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) length += 2;
    else if (code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) length += 2;
    else if (code < 0x20) length += 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 2;
        i++;
      } else {
        length += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) length += 6;
    else length += 1;
  }
  return length;
}

function jsonSerializedLength(value: unknown): number {
  if (typeof value === 'string') return jsonStringLength(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value)?.length ?? 0;
  if (Array.isArray(value)) {
    let length = 2;
    for (let i = 0; i < value.length; i++) {
      if (i > 0) length++;
      const item = value[i];
      length += item === undefined || typeof item === 'function' || typeof item === 'symbol' ? 4 : jsonSerializedLength(item);
    }
    return length;
  }
  let length = 2;
  let hasProperty = false;
  for (const key of Object.keys(value)) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
    if (hasProperty) length++;
    length += jsonStringLength(key) + 1 + jsonSerializedLength(item);
    hasProperty = true;
  }
  return length;
}

export function estimateAnthropicInputTokens(body: Record<string, unknown>): number {
  let tokens = 0;
  const countText = (value: unknown) => {
    tokens += estimateTextTokens(value);
  };
  // Count block text directly instead of joining it into one string: tool
  // results can be large and the join would allocate a second full copy.
  const countToolResult = (content: unknown, isError: unknown) => {
    if (isError) countText('[Tool execution error]\n');
    if (content === undefined || content === null) return;
    if (typeof content === 'string') {
      countText(content);
      return;
    }
    if (!Array.isArray(content)) {
      countText(JSON.stringify(content));
      return;
    }
    let hasPreviousPart = false;
    for (const block of content) {
      let part = '';
      if (typeof block === 'string') part = block;
      else if (!block || typeof block !== 'object') part = String(block ?? '');
      else if (block.type === 'text') part = String(block.text || '');
      else if (block.type === 'image') part = '[Tool-result image]';
      else part = JSON.stringify(block) || '';
      if (!part) continue;
      if (hasPreviousPart) countText('\n');
      countText(part);
      hasPreviousPart = true;
    }
  };
  if (typeof body.system === 'string') countText(body.system);
  else if (Array.isArray(body.system)) for (const x of body.system) countText(x?.text || x);
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    tokens += 2; // per-message structural overhead
    if (typeof message.content === 'string') countText(message.content);
    else
      for (const block of message.content || []) {
        if (block?.type === 'text') countText(block.text);
        else if (block?.type === 'tool_use') countText(JSON.stringify(block.input || {}));
        else if (block?.type === 'tool_result') countToolResult(block.content, block.is_error);
        else if (block?.type === 'image') tokens += 1600;
        else countText(JSON.stringify(block));
      }
  }
  // Tool schemas are dense JSON: charge them at a denser ratio plus a fixed
  // per-tool overhead instead of the plain-text ratio.
  const tools = Array.isArray(body.tools) ? body.tools : [];
  tokens += jsonSerializedLength(tools) / 3 + tools.length * 64;
  return Math.max(1, Math.ceil(tokens));
}
