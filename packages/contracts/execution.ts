// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Internal execution contract v1-v6 with optional phase deadlines. This module is intentionally runtime-neutral:
// no Provider, Gateway, Cloudflare, Node.js or database imports.

import { type InferenceStreamBudget, parseInferenceStreamBudget, serializeInferenceStreamBudget } from './inference-stream-budget.ts';
import { validatedInternalTraceparent } from './trace-context.ts';

export const EXECUTION_CONTRACT_VERSION = '1' as const;
export const EXECUTION_TRANSLATION_CONTRACT_VERSION = '2' as const;
export const EXECUTION_OBJECT_CONTRACT_VERSION = '3' as const;
export const EXECUTION_STREAM_CONTRACT_VERSION = '4' as const;
export const EXECUTION_BUDGET_STREAM_CONTRACT_VERSION = '5' as const;
export const EXECUTION_COLLECTED_OBJECT_CONTRACT_VERSION = '6' as const;
export const INFERENCE_TRANSLATED_OBJECT_FORMAT = 'translated-object-v1' as const;
export const EXECUTION_PATH = '/internal/execute' as const;
export const MAX_EXECUTION_DEADLINE_AHEAD_MS = 10 * 60 * 1000;

export type ExecutionCenter = 'inference' | 'perception' | 'generation';
export type ExecutionSurface = 'chat_completions' | 'responses' | 'messages' | 'images_generations';
export type ExecutionInputSurface = Exclude<ExecutionSurface, 'images_generations'>;
export type ExecutionDisposition = 'not-dispatched' | 'attempted' | 'dispatched';

/** Stable internal wire markers. "attempted" does not prove an upstream request was rejected. */
export const EXECUTION_WIRE_RESULT = {
  NOT_DISPATCHED: 'not-dispatched',
  SKIPPED: 'skipped',
  ATTEMPTED: 'attempted',
  DISPATCHED: 'dispatched',
} as const;
export type ExecutionWireResult = (typeof EXECUTION_WIRE_RESULT)[keyof typeof EXECUTION_WIRE_RESULT];

/** Known cross-boundary errors that affect stage classification and retry decisions. */
export const EXECUTION_ERROR_CODE = {
  CENTER_ROUTE_UNAVAILABLE: 'center_route_unavailable',
  CENTER_UPSTREAM_NETWORK: 'center_upstream_network',
  CENTER_UPSTREAM_HEADERS_TIMEOUT: 'center_upstream_headers_timeout',
  CENTER_EXECUTION_DEADLINE: 'center_execution_deadline',
  CENTER_BODY_BUDGET_EXHAUSTED: 'center_body_budget_exhausted',
  CENTER_CONVERSION_BUDGET_EXCEEDED: 'center_conversion_budget_exceeded',
  GENERATION_OUTCOME_UNKNOWN: 'generation_outcome_unknown',
  GATEWAY_INFERENCE_CENTER_UNAVAILABLE: 'gateway_inference_center_unavailable',
  GATEWAY_INFERENCE_CENTER_TIMEOUT: 'gateway_inference_center_timeout',
  GATEWAY_INFERENCE_CENTER_TRANSPORT_ERROR: 'gateway_inference_center_transport_error',
  GATEWAY_INFERENCE_UPSTREAM_OUTCOME_UNKNOWN: 'gateway_inference_upstream_outcome_unknown',
  GATEWAY_INFERENCE_EXECUTION_TIMEOUT: 'gateway_inference_execution_timeout',
} as const;
export type ExecutionErrorCode = (typeof EXECUTION_ERROR_CODE)[keyof typeof EXECUTION_ERROR_CODE];
export type ExecutionPhase =
  | 'pre-dispatch'
  | 'upstream-network'
  | 'upstream-headers'
  | 'upstream-attempted'
  | 'execution-deadline'
  | 'upstream-dispatched'
  | 'center-unconfirmed';

const KNOWN_EXECUTION_CODES: ReadonlySet<string> = new Set(Object.values(EXECUTION_ERROR_CODE));

/** Preserve the existing private error envelope (Inference includes retryable, Generation does not). */
export function serializeExecutionError(status: number, code: string, options: { retryable?: boolean; result?: ExecutionWireResult } = {}): Response {
  const { retryable, result } = options;
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-aig-error-kind': code,
  });
  if (retryable !== undefined) headers.set('x-aig-retryable', String(retryable));
  if (result !== undefined) headers.set('x-aig-result', result);
  return new Response(JSON.stringify({ error: { code, ...(retryable !== undefined ? { retryable } : {}) } }), { status, headers });
}

/**
 * Distinguish center transport from attempted Provider fetch and post-header
 * execution. Only an authenticated, exact "skipped" signal can prove that
 * a request was never dispatched; a missing or forged marker never can.
 */
export function parseExecutionResponse(response: Response): {
  result: ExecutionWireResult | null;
  code: ExecutionErrorCode | null;
  phase: ExecutionPhase;
  verifiedPreDispatchRotation: boolean;
} {
  const rawResult = response.headers.get('x-aig-result');
  const result =
    rawResult === EXECUTION_WIRE_RESULT.SKIPPED ||
    rawResult === EXECUTION_WIRE_RESULT.NOT_DISPATCHED ||
    rawResult === EXECUTION_WIRE_RESULT.ATTEMPTED ||
    rawResult === EXECUTION_WIRE_RESULT.DISPATCHED
      ? rawResult
      : null;
  const rawCode = response.headers.get('x-aig-error-kind');
  const code = rawCode !== null && KNOWN_EXECUTION_CODES.has(rawCode) ? (rawCode as ExecutionErrorCode) : null;
  const verifiedPreDispatchRotation =
    result === EXECUTION_WIRE_RESULT.SKIPPED &&
    ((response.status === 404 && code === EXECUTION_ERROR_CODE.CENTER_ROUTE_UNAVAILABLE) ||
      (response.status === 504 && code === EXECUTION_ERROR_CODE.CENTER_UPSTREAM_HEADERS_TIMEOUT));
  let phase: ExecutionPhase = 'center-unconfirmed';
  if (result === EXECUTION_WIRE_RESULT.SKIPPED || result === EXECUTION_WIRE_RESULT.NOT_DISPATCHED) phase = 'pre-dispatch';
  else if (result === EXECUTION_WIRE_RESULT.ATTEMPTED) {
    phase =
      code === EXECUTION_ERROR_CODE.CENTER_UPSTREAM_NETWORK
        ? 'upstream-network'
        : code === EXECUTION_ERROR_CODE.CENTER_UPSTREAM_HEADERS_TIMEOUT
          ? 'upstream-headers'
          : 'upstream-attempted';
  } else if (result === EXECUTION_WIRE_RESULT.DISPATCHED) {
    phase = code === EXECUTION_ERROR_CODE.CENTER_EXECUTION_DEADLINE ? 'execution-deadline' : 'upstream-dispatched';
  }
  return { result, code, phase, verifiedPreDispatchRotation };
}

export type ExecutionInvocation = {
  requestId: string;
  /** Server-generated parent span; untrusted client trace headers are excluded. */
  traceparent?: string;
  nodeId: string;
  logicalModel: string;
  surface: ExecutionSurface;
  deadlineMs: number;
  /** Optional Provider response-header deadline, earlier than the overall request deadline. */
  upstreamHeadersDeadlineMs?: number;
  /** Optional buffered conversion deadline, leaving time to return a result through Service Binding. */
  bufferedResponseDeadlineMs?: number;
  /** The original client shape when Inference performs cross-protocol conversion. */
  inputSurface?: ExecutionInputSurface;
  /** Absent unless the Gateway explicitly prefers a non-streaming upstream. */
  preferNonstream?: true;
  /** v3: translate a buffered object; v6: collect an upstream stream into a translated object in the private center. */
  returnObject?: true;
  /** v4 only: private framed SSE for client-streaming requests. */
  returnStream?: true;
  /** v5 streaming or v6 collected-object conversion budget; v3/v4 forbid this field. */
  streamBudget?: InferenceStreamBudget;
  /** The authorized public model name, not the physical Provider model. */
  displayModel?: string;
};

export type ExecutionError = {
  error: { code: string; retryable?: boolean };
};

export type TranslatedObjectEnvelope = {
  kind: typeof INFERENCE_TRANSLATED_OBJECT_FORMAT;
  response: Record<string, unknown>;
  /** Physical upstream usage, never the client-facing normalized usage. */
  upstreamUsage: unknown;
};

/** Validate private center response before Gateway treats it as pretranslated. */
export function isTranslatedObjectEnvelope(value: unknown): value is TranslatedObjectEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope.kind === INFERENCE_TRANSLATED_OBJECT_FORMAT &&
    !!envelope.response &&
    typeof envelope.response === 'object' &&
    !Array.isArray(envelope.response) &&
    Object.hasOwn(envelope, 'upstreamUsage')
  );
}

export type UsageEvent = {
  requestId: string;
  nodeId: string;
  center: ExecutionCenter;
  disposition: ExecutionDisposition;
  inputTokens?: number;
  outputTokens?: number;
  upstreamStatus?: number;
  elapsedMs?: number;
};

/** A Request/Response transport: a Service Binding or standard private HTTP. */
export type ExecutionTransport = { fetch(request: Request): Promise<Response> };

/** Only gateway-generated metadata is included; no client credentials are forwarded. */
export function buildExecutionHeaders(invocation: ExecutionInvocation, authHeader: string, authKey: string): Headers {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-aig-contract-version':
      invocation.returnStream && invocation.streamBudget
        ? EXECUTION_BUDGET_STREAM_CONTRACT_VERSION
        : invocation.returnStream
          ? EXECUTION_STREAM_CONTRACT_VERSION
          : invocation.returnObject
            ? invocation.preferNonstream
              ? EXECUTION_OBJECT_CONTRACT_VERSION
              : EXECUTION_COLLECTED_OBJECT_CONTRACT_VERSION
            : invocation.inputSurface
              ? EXECUTION_TRANSLATION_CONTRACT_VERSION
              : EXECUTION_CONTRACT_VERSION,
    'x-aig-request-id': invocation.requestId,
    'x-aig-node-id': invocation.nodeId,
    'x-aig-model': invocation.logicalModel,
    'x-aig-surface': invocation.surface,
    'x-aig-deadline-ms': String(invocation.deadlineMs),
    [authHeader]: authKey,
  });
  if (invocation.upstreamHeadersDeadlineMs !== undefined)
    headers.set('x-aig-upstream-headers-deadline-ms', String(invocation.upstreamHeadersDeadlineMs));
  if (invocation.bufferedResponseDeadlineMs !== undefined)
    headers.set('x-aig-buffered-response-deadline-ms', String(invocation.bufferedResponseDeadlineMs));
  if (invocation.inputSurface) headers.set('x-aig-input-surface', invocation.inputSurface);
  if (invocation.preferNonstream) headers.set('x-aig-conversion-prefer-nonstream', 'true');
  if (invocation.returnObject) headers.set('x-aig-return-object', 'true');
  if (invocation.returnStream) headers.set('x-aig-return-stream', 'true');
  if (invocation.streamBudget) headers.set('x-aig-stream-budget', serializeInferenceStreamBudget(invocation.streamBudget));
  if (invocation.displayModel) headers.set('x-aig-display-model', invocation.displayModel);
  const traceparent = validatedInternalTraceparent(invocation.requestId, invocation.traceparent);
  if (traceparent) headers.set('traceparent', traceparent);
  return headers;
}

/** This checks syntax and lifetime only. Centers MUST also verify node/model authorization. */
export function parseExecutionInvocation(
  request: Request,
  allowedSurfaces: ReadonlySet<ExecutionSurface>,
  nowMs = Date.now(),
): ExecutionInvocation | null {
  const version = request.headers.get('x-aig-contract-version');
  if (
    version !== EXECUTION_CONTRACT_VERSION &&
    version !== EXECUTION_TRANSLATION_CONTRACT_VERSION &&
    version !== EXECUTION_OBJECT_CONTRACT_VERSION &&
    version !== EXECUTION_STREAM_CONTRACT_VERSION &&
    version !== EXECUTION_BUDGET_STREAM_CONTRACT_VERSION &&
    version !== EXECUTION_COLLECTED_OBJECT_CONTRACT_VERSION
  )
    return null;
  const requestId = request.headers.get('x-aig-request-id') ?? '';
  const nodeId = request.headers.get('x-aig-node-id') ?? '';
  const logicalModel = request.headers.get('x-aig-model') ?? '';
  const rawSurface = request.headers.get('x-aig-surface') ?? '';
  const rawDeadline = request.headers.get('x-aig-deadline-ms') ?? '';
  if (!/^[a-f0-9-]{36}$/i.test(requestId)) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nodeId)) return null;
  if (!logicalModel || logicalModel.length > 128 || /[\r\n]/.test(logicalModel)) return null;
  if (!allowedSurfaces.has(rawSurface as ExecutionSurface)) return null;
  if (!/^\d{13}$/.test(rawDeadline)) return null;
  const deadlineMs = Number(rawDeadline);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= nowMs || deadlineMs > nowMs + MAX_EXECUTION_DEADLINE_AHEAD_MS) return null;
  const parseOptionalDeadline = (headerName: string): number | undefined | null => {
    const raw = request.headers.get(headerName);
    if (raw === null) return undefined;
    if (!/^\d{13}$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > nowMs && value <= deadlineMs ? value : null;
  };
  const upstreamHeadersDeadlineMs = parseOptionalDeadline('x-aig-upstream-headers-deadline-ms');
  const bufferedResponseDeadlineMs = parseOptionalDeadline('x-aig-buffered-response-deadline-ms');
  if (upstreamHeadersDeadlineMs === null || bufferedResponseDeadlineMs === null) return null;
  const rawInputSurface = request.headers.get('x-aig-input-surface');
  const preferNonstream = request.headers.get('x-aig-conversion-prefer-nonstream');
  const returnObject = request.headers.get('x-aig-return-object');
  const returnStream = request.headers.get('x-aig-return-stream');
  const displayModel = request.headers.get('x-aig-display-model');
  const rawStreamBudget = request.headers.get('x-aig-stream-budget');
  if (bufferedResponseDeadlineMs !== undefined && returnObject !== 'true' && returnStream !== 'true') return null;
  const budgetCapable = version === EXECUTION_BUDGET_STREAM_CONTRACT_VERSION || version === EXECUTION_COLLECTED_OBJECT_CONTRACT_VERSION;
  const streamBudget = budgetCapable && rawStreamBudget !== null ? parseInferenceStreamBudget(rawStreamBudget) : null;
  if (
    version === EXECUTION_BUDGET_STREAM_CONTRACT_VERSION
      ? streamBudget === null
      : rawStreamBudget !== null && (!budgetCapable || streamBudget === null)
  )
    return null;
  if (rawInputSurface === null) {
    if (version !== EXECUTION_CONTRACT_VERSION || preferNonstream !== null || returnObject !== null || returnStream !== null || displayModel !== null)
      return null;
    return {
      requestId,
      nodeId,
      logicalModel,
      surface: rawSurface as ExecutionSurface,
      deadlineMs,
      ...(upstreamHeadersDeadlineMs !== undefined ? { upstreamHeadersDeadlineMs } : {}),
    };
  }
  if (
    (version !== EXECUTION_TRANSLATION_CONTRACT_VERSION &&
      version !== EXECUTION_OBJECT_CONTRACT_VERSION &&
      version !== EXECUTION_STREAM_CONTRACT_VERSION &&
      version !== EXECUTION_BUDGET_STREAM_CONTRACT_VERSION &&
      version !== EXECUTION_COLLECTED_OBJECT_CONTRACT_VERSION) ||
    rawSurface === 'images_generations' ||
    !['chat_completions', 'responses', 'messages'].includes(rawInputSurface) ||
    rawInputSurface === rawSurface
  )
    return null;
  if (preferNonstream !== null && preferNonstream !== 'true') return null;
  if (version === EXECUTION_OBJECT_CONTRACT_VERSION && (returnObject !== 'true' || preferNonstream !== 'true')) return null;
  if (version === EXECUTION_COLLECTED_OBJECT_CONTRACT_VERSION && (returnObject !== 'true' || preferNonstream !== null)) return null;
  if (version === EXECUTION_STREAM_CONTRACT_VERSION || version === EXECUTION_BUDGET_STREAM_CONTRACT_VERSION) {
    if (
      returnStream !== 'true' ||
      returnObject !== null ||
      preferNonstream !== null ||
      !displayModel ||
      displayModel.length > 128 ||
      /[\r\n]/.test(displayModel)
    )
      return null;
  } else if (returnStream !== null || displayModel !== null) return null;
  if (version === EXECUTION_TRANSLATION_CONTRACT_VERSION && returnObject !== null) return null;
  return {
    requestId,
    nodeId,
    logicalModel,
    surface: rawSurface as ExecutionSurface,
    deadlineMs,
    ...(upstreamHeadersDeadlineMs !== undefined ? { upstreamHeadersDeadlineMs } : {}),
    ...(bufferedResponseDeadlineMs !== undefined ? { bufferedResponseDeadlineMs } : {}),
    inputSurface: rawInputSurface as ExecutionInputSurface,
    ...(preferNonstream === 'true' ? { preferNonstream: true as const } : {}),
    ...(returnObject === 'true' ? { returnObject: true as const } : {}),
    ...(returnStream === 'true' ? { returnStream: true as const, displayModel: displayModel as string } : {}),
    ...(streamBudget ? { streamBudget } : {}),
  };
}

function constantTimeMatch(received: string, expected: string): boolean {
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Center-specific high-entropy credential; does not authenticate end-user access keys. */
export function authorizeExecutionRequest(request: Request, expectedKey: unknown, headerName: string): boolean {
  if (typeof expectedKey !== 'string' || expectedKey.length < 32) return false;
  const supplied = request.headers.get(headerName) ?? '';
  if (supplied.length < 32 || supplied.length > 1024) return false;
  return constantTimeMatch(supplied, expectedKey);
}
