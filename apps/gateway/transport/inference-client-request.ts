// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Private transport adapter for the inference executor. Keep the contract
// independent of Cloudflare RPC so an HTTPS backend can implement it later.

import type { ExecutionInputSurface, ExecutionTransport } from '../../../packages/contracts/execution.ts';
import { buildExecutionHeaders } from '../../../packages/contracts/execution.ts';
import type { InferenceStreamBudget } from '../../../packages/contracts/inference-stream-budget.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';
import type { Surface } from '../../../src/types/protocol.ts';
import type { GatewayEnv } from '../../../src/types/runtime.ts';

export type InferenceInvocation = {
  request: Request;
  requestId: string;
  node: RuntimeNode;
  logicalModel: string;
  surface: Surface;
  inputSurface?: ExecutionInputSurface;
  preferNonstream?: true;
  returnObject?: true;
  returnStream?: true;
  streamBudget?: InferenceStreamBudget;
  displayModel?: string;
  deadlineMs: number;
  body: string;
  signal?: AbortSignal;
};

export class InferenceCenterUnavailable extends Error {
  constructor() {
    super('Private inference center is not configured.');
    this.name = 'InferenceCenterUnavailable';
  }
}

type InferenceService = ExecutionTransport;

export function configuredInferenceService(env: GatewayEnv): InferenceService {
  const service = env.AIG_INFERENCE_SERVICE as InferenceService | undefined;
  const key = env.AIG_INFERENCE_AUTH_KEY;
  if (!service || typeof service.fetch !== 'function' || typeof key !== 'string' || key.length < 32) {
    throw new InferenceCenterUnavailable();
  }
  return service;
}

/** Build one request. Caller remains responsible for retries, budgets and SSE commit. */
export function buildInferenceRequest(env: GatewayEnv, invocation: InferenceInvocation): Request {
  configuredInferenceService(env);
  const key = env.AIG_INFERENCE_AUTH_KEY as string;
  const headers = buildExecutionHeaders(
    {
      requestId: invocation.requestId,
      nodeId: invocation.node.id,
      logicalModel: invocation.logicalModel,
      surface: invocation.surface,
      deadlineMs: invocation.deadlineMs,
      inputSurface: invocation.inputSurface,
      preferNonstream: invocation.preferNonstream,
      returnObject: invocation.returnObject,
      returnStream: invocation.returnStream,
      streamBudget: invocation.streamBudget,
      displayModel: invocation.displayModel,
    },
    'x-aig-inference-auth',
    key,
  );
  for (const name of ['accept', 'anthropic-version', 'anthropic-beta', 'idempotency-key']) {
    const value = invocation.request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Trust only the Gateway's freshly serialized body, never the untrusted
  // client's Content-Length. This lets the center charge the real private
  // payload size before reading it, even when the client used chunked upload.
  headers.set('content-length', String(new Blob([invocation.body]).size));
  return new Request('https://inference.internal/internal/execute', {
    method: 'POST',
    headers,
    body: invocation.body,
    signal: invocation.signal ?? invocation.request.signal,
  });
}

/** No implicit fallback to the legacy provider network path. */
export async function invokeInferenceNode(env: GatewayEnv, invocation: InferenceInvocation): Promise<Response> {
  const service = configuredInferenceService(env);
  return service.fetch(buildInferenceRequest(env, invocation));
}
