// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { corsHeaders, shouldNotRetryHeaders } from '../http.ts';
import { buildResponsesError, responsesErrorTypeForStatus } from './events.ts';
import { collectResponsesObject, synthesizeResponsesFromObject } from './native-stream.ts';

export function validateOpenAIResponsesRequest(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  const b = body as Record<string, unknown>;
  if (!b.model || typeof b.model !== 'string' || !b.model.trim()) return 'model is required and must be a non-empty string.';
  if (b.input === undefined || b.input === null) return 'input is required.';
  return null;
}

export function responsesErrorResponse(
  request: Request,
  env: Record<string, unknown>,
  status: number,
  message: unknown,
  requestId?: string,
  extraHeaders?: Record<string, string>,
  gatewayCode: string | null = null,
  isRetryable: boolean = false,
): Response {
  const body = buildResponsesError(message, responsesErrorTypeForStatus(status));
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId || '',
      ...(extraHeaders || {}),
      ...(gatewayCode ? { 'x-gateway-error-code': gatewayCode } : {}),
      ...shouldNotRetryHeaders(status, isRetryable),
      ...corsHeaders(request, env),
    },
  });
}

export { formatResponsesSseEvent, ResponsesEventBuilder } from './events.ts';
export { buildResponsesError, collectResponsesObject, responsesErrorTypeForStatus, synthesizeResponsesFromObject };
