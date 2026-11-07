// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Conversion admission only. No OAuth, Provider dispatch or scheduler state.
import type { InferencePreflightInvocation } from '../../packages/contracts/conversion-preflight.ts';
import { ConversionError, isRecord } from '../../packages/conversion-core/validation.ts';
import { BodyTooLargeError, readBodyTextWithLimit } from '../../src/protocol/http.ts';
import { convertMatrixRequest, isMatrixPair } from './conversion/request.ts';
import { problem } from './response.ts';

const MAX_PREFLIGHT_BYTES = 2 * 1024 * 1024;
const MATRIX_PROTOCOLS = ['openai_chat', 'openai_responses', 'anthropic'] as const;

export async function handleInferencePreflight(request: Request, invocation: InferencePreflightInvocation): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return problem(415, 'center_content_type_invalid');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PREFLIGHT_BYTES) return problem(413, 'center_body_too_large');

  let data: Record<string, unknown>;
  try {
    const raw = await readBodyTextWithLimit(request, MAX_PREFLIGHT_BYTES);
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return problem(400, 'center_preflight_invalid');
    data = parsed;
  } catch (error) {
    return problem(error instanceof BodyTooLargeError ? 413 : 400, 'center_preflight_invalid');
  }
  if (Date.now() >= invocation.deadlineMs) return problem(408, 'center_deadline_expired');
  const { from, to, body, isNonstreamPreferred } = data;
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    !MATRIX_PROTOCOLS.includes(from as (typeof MATRIX_PROTOCOLS)[number]) ||
    !MATRIX_PROTOCOLS.includes(to as (typeof MATRIX_PROTOCOLS)[number]) ||
    !isMatrixPair(from as (typeof MATRIX_PROTOCOLS)[number], to as (typeof MATRIX_PROTOCOLS)[number]) ||
    !isRecord(body) ||
    (isNonstreamPreferred !== undefined && typeof isNonstreamPreferred !== 'boolean')
  )
    return problem(400, 'center_preflight_invalid');

  try {
    const result = convertMatrixRequest(from as (typeof MATRIX_PROTOCOLS)[number], to as (typeof MATRIX_PROTOCOLS)[number], body, {
      isNonstreamPreferred: isNonstreamPreferred === true,
    });
    // Never return translated prompts, messages, tool schemas or raw Provider metadata.
    return new Response(
      JSON.stringify({
        ok: true,
        fidelity: result.fidelity,
        diagnostics: result.diagnostics,
        ...(result.structuredOutput ? { structuredOutput: result.structuredOutput } : {}),
      }),
      { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof ConversionError) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'conversion_not_supported',
          ...(error.requestField ? { requestField: error.requestField.slice(0, 64) } : {}),
        }),
        { status: 422, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
      );
    }
    throw error;
  }
}
