// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import { corsHeaders } from '../../../src/protocol/http.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';

const streamErrorEncoder = new TextEncoder();

const STREAM_FAILURE_CODES: ReadonlySet<string> = new Set([
  'first_event_timeout',
  'empty_stream',
  'done_only_stream',
  'client_aborted',
  'malformed_first_event',
  'first_event_error_envelope',
  'first_event_pre_bytes_exceeded',
  'first_event_sse_line_exceeded',
  'reader_error',
  'idle_timeout',
  'upstream_terminal_failure',
  'missing_completion_marker',
  'incomplete_response',
  'sse_observation_truncated',
  'malformed_sse',
  'bytes_after_terminal',
]);

export function finalHeaders(env: GatewayEnv, request: Request, sourceHeaders?: Headers | null, extraHeaders?: Record<string, string>): Headers {
  const headers = new Headers();
  if (sourceHeaders) {
    const contentType = sourceHeaders.get('content-type');
    if (contentType) headers.set('content-type', contentType);
    const buffering = sourceHeaders.get('x-accel-buffering');
    if (buffering) headers.set('x-accel-buffering', buffering);
  }
  for (const [key, value] of Object.entries(extraHeaders || {})) headers.set(key, value);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value);
  return headers;
}

export function jsonResponse(status: number, data: unknown, env: GatewayEnv, request: Request, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      ...(extraHeaders || {}),
      ...corsHeaders(request, env),
    },
  });
}

export function streamInterruptionChunk(
  route: string,
  requestId: string,
  reason: string | null,
  {
    nextSequenceNumber = 0,
    message: messageOverride,
    code = 'stream_interrupted',
  }: { nextSequenceNumber?: number; message?: string; code?: string } = {},
): Uint8Array {
  const safeReason = reason && STREAM_FAILURE_CODES.has(reason) ? reason : 'unknown';
  const message = messageOverride ?? `Gateway upstream stream interrupted (${safeReason}).`;
  let event: string;
  if (route === 'openai_responses') {
    event = `event: error\ndata: ${JSON.stringify({ type: 'error', code, message, param: null, sequence_number: nextSequenceNumber })}\n\n`;
  } else if (route === 'anthropic_messages') {
    event = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`;
  } else {
    event = `data: ${JSON.stringify({ error: { message, type: 'api_error', code } })}\n\n`;
  }
  return streamErrorEncoder.encode(event);
}

export function upstreamModelOf(node: RuntimeNode, logicalModel: string): string {
  return node.models[logicalModel] || logicalModel;
}
