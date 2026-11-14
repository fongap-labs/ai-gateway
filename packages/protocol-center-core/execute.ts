// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// One stateless request conversion before private Inference execution.
// Provider secrets, Key rotation, retries and upstream networking stay in Inference/Gateway.
import { getLimits } from '../config-core/timeouts.ts';
import { buildExecutionHeaders, EXECUTION_WIRE_RESULT, type ExecutionInvocation, serializeExecutionError } from '../contracts/execution.ts';
import type { GatewayEnv } from '../contracts/runtime.ts';
import { prepareProtocolRequest } from '../conversion-core/matrix/request-protocol-adapter.ts';
import { BodyTooLargeError, readBodyTextWithLimit } from '../transport/http.ts';

function rejected(status: number, code: string): Response {
  return serializeExecutionError(status, code, { retryable: false, result: EXECUTION_WIRE_RESULT.NOT_DISPATCHED });
}

export async function executeProtocolRequest(request: Request, env: GatewayEnv, invocation: ExecutionInvocation): Promise<Response> {
  if (!invocation.inputSurface || invocation.preparedRequest) return rejected(400, 'protocol_execution_contract_invalid');
  const center = env.AIG_INFERENCE_SERVICE as { fetch?: (request: Request) => Promise<Response> } | undefined;
  const auth = env.AIG_INFERENCE_AUTH_KEY;
  if (typeof center?.fetch !== 'function' || typeof auth !== 'string' || auth.length < 32) {
    return rejected(503, 'protocol_inference_binding_unavailable');
  }

  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    return rejected(415, 'protocol_execution_content_type_invalid');
  }
  const maxBytes = getLimits(env).maxBodyBytes;
  let original: Record<string, unknown>;
  try {
    const text = await readBodyTextWithLimit(request, maxBytes);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rejected(400, 'protocol_execution_body_invalid');
    original = parsed as Record<string, unknown>;
  } catch (error) {
    return rejected(error instanceof BodyTooLargeError ? 413 : 400, 'protocol_execution_body_invalid');
  }

  if (original.model !== invocation.logicalModel || (original.stream !== undefined && typeof original.stream !== 'boolean')) {
    return rejected(400, 'protocol_execution_request_invalid');
  }
  if (invocation.returnStream && original.stream !== true) return rejected(400, 'protocol_execution_stream_invalid');
  if (invocation.returnObject && original.stream === true) return rejected(400, 'protocol_execution_stream_invalid');
  const prepared = prepareProtocolRequest(original, invocation.inputSurface, invocation.surface, invocation.preferNonstream === true);
  if (!prepared.ok) return rejected(prepared.status, prepared.code);
  const body = JSON.stringify(prepared.body);
  const bytes = new Blob([body]).size;
  if (bytes > maxBytes) return rejected(413, 'protocol_execution_body_too_large');
  if (Date.now() >= invocation.deadlineMs) return rejected(504, 'protocol_execution_deadline');

  const headers = buildExecutionHeaders(
    { ...invocation, traceparent: request.headers.get('traceparent') ?? undefined, preparedRequest: true },
    'x-aig-inference-auth',
    auth,
  );
  for (const name of ['accept', 'anthropic-version', 'anthropic-beta', 'idempotency-key']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('content-length', String(bytes));
  const forwarding = new Request('https://inference.internal/internal/execute', {
    method: 'POST',
    headers,
    body,
    signal: request.signal,
  });
  // Do not buffer or inspect the response: streaming and settled usage remain
  // owned by Inference, including framed cross-protocol SSE.
  try {
    return await center.fetch(forwarding);
  } catch {
    // Provider execution may already have begun; do not claim NOT_DISPATCHED.
    return serializeExecutionError(503, 'protocol_inference_outcome_unknown', { retryable: false });
  }
}
