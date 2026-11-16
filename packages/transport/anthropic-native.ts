// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

import type { Surface } from '../contracts/protocol.ts';

export const ANTHROPIC_SURFACE_PATH = Object.freeze({
  messages: '/v1/messages',
});

export function resolveAnthropicPath(surface: Surface): string {
  const path = (ANTHROPIC_SURFACE_PATH as Record<string, string | undefined>)[surface];
  if (!path) throw new Error(`unknown Anthropic surface: ${surface}`);
  return path;
}

export function buildAnthropicHeaders(request: Request, credential: string, requestId: string): Headers {
  const headers = new Headers();
  headers.set('x-api-key', credential);
  const clientVersion = request.headers.get('anthropic-version');
  headers.set('anthropic-version', clientVersion || '2023-06-01');
  const clientBeta = request.headers.get('anthropic-beta');
  if (clientBeta) headers.set('anthropic-beta', clientBeta.slice(0, 512));
  headers.set('Content-Type', request.headers.get('content-type') || 'application/json');
  headers.set('Accept', request.headers.get('accept') || 'application/json');
  headers.set('User-Agent', 'ai-gateway');
  headers.set('Accept-Encoding', 'identity');
  headers.set('X-Request-ID', requestId);
  return headers;
}

export function isAnthropicNativeRealOutput(json: unknown): boolean {
  if (!isRecord(json)) return false;
  if (json?.type !== 'content_block_delta') return false;
  const delta = isRecord(json.delta) ? json.delta : {};
  if (delta?.type === 'text_delta') return typeof delta.text === 'string' && delta.text.trim().length > 0;
  if (delta?.type === 'thinking_delta') return typeof delta.thinking === 'string' && delta.thinking.trim().length > 0;
  if (delta?.type === 'input_json_delta') return typeof delta.partial_json === 'string' && delta.partial_json.trim().length > 0;
  return false;
}

export function isAnthropicMessageMeaningful(json: unknown): boolean {
  if (!isRecord(json)) return false;
  for (const block of Array.isArray(json.content) ? json.content : []) {
    if (
      (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) ||
      (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim().length > 0)
    )
      return true;
    if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name.trim().length > 0) return true;
  }
  return false;
}

export function isAnthropicNativeRealOutputForConversion(json: unknown): boolean {
  if (!isRecord(json)) return false;
  if (json?.type !== 'content_block_delta') return false;
  const delta = isRecord(json.delta) ? json.delta : {};
  if (delta?.type === 'text_delta') return typeof delta.text === 'string' && delta.text.trim().length > 0;
  if (delta?.type === 'thinking_delta') return typeof delta.thinking === 'string' && delta.thinking.trim().length > 0;
  if (delta?.type === 'input_json_delta') return typeof delta.partial_json === 'string' && delta.partial_json.trim().length > 0;
  return false;
}
