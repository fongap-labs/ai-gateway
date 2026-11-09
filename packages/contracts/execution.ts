// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Internal execution contract v1-v6. This module is intentionally runtime-neutral:
// no Provider, Gateway, Cloudflare, Node.js or database imports.

import { type InferenceStreamBudget, parseInferenceStreamBudget, serializeInferenceStreamBudget } from './inference-stream-budget.ts';

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

export type ExecutionInvocation = {
  requestId: string;
  nodeId: string;
  logicalModel: string;
  surface: ExecutionSurface;
  deadlineMs: number;
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
  if (invocation.inputSurface) headers.set('x-aig-input-surface', invocation.inputSurface);
  if (invocation.preferNonstream) headers.set('x-aig-conversion-prefer-nonstream', 'true');
  if (invocation.returnObject) headers.set('x-aig-return-object', 'true');
  if (invocation.returnStream) headers.set('x-aig-return-stream', 'true');
  if (invocation.streamBudget) headers.set('x-aig-stream-budget', serializeInferenceStreamBudget(invocation.streamBudget));
  if (invocation.displayModel) headers.set('x-aig-display-model', invocation.displayModel);
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
  const rawInputSurface = request.headers.get('x-aig-input-surface');
  const preferNonstream = request.headers.get('x-aig-conversion-prefer-nonstream');
  const returnObject = request.headers.get('x-aig-return-object');
  const returnStream = request.headers.get('x-aig-return-stream');
  const displayModel = request.headers.get('x-aig-display-model');
  const rawStreamBudget = request.headers.get('x-aig-stream-budget');
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
    return { requestId, nodeId, logicalModel, surface: rawSurface as ExecutionSurface, deadlineMs };
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
