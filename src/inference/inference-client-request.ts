// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Private transport adapter for the inference executor. Keep the contract
// independent of Cloudflare RPC so an HTTPS backend can implement it later.

import type { RuntimeNode } from '../types/node.ts';
import type { Surface } from '../types/protocol.ts';
import type { GatewayEnv } from '../types/runtime.ts';

export type InferenceInvocation = {
  request: Request;
  requestId: string;
  node: RuntimeNode;
  logicalModel: string;
  surface: Surface;
  deadlineMs: number;
  body: string;
};

export class InferenceCenterUnavailable extends Error {
  constructor() {
    super('Private inference center is not configured.');
    this.name = 'InferenceCenterUnavailable';
  }
}

type InferenceService = { fetch: (request: Request) => Promise<Response> };

function configuredService(env: GatewayEnv): InferenceService {
  const service = env.AIG_INFERENCE_SERVICE as InferenceService | undefined;
  const key = env.AIG_INFERENCE_AUTH_KEY;
  if (!service || typeof service.fetch !== 'function' || typeof key !== 'string' || key.length < 32) {
    throw new InferenceCenterUnavailable();
  }
  return service;
}

/** Build one request. Caller remains responsible for retries, budgets and SSE commit. */
export function buildInferenceRequest(env: GatewayEnv, invocation: InferenceInvocation): Request {
  configuredService(env);
  const key = env.AIG_INFERENCE_AUTH_KEY as string;
  const headers = new Headers({
    'content-type': 'application/json',
    'x-aig-contract-version': '1',
    'x-aig-request-id': invocation.requestId,
    'x-aig-node-id': invocation.node.id,
    'x-aig-model': invocation.logicalModel,
    'x-aig-surface': invocation.surface,
    'x-aig-deadline-ms': String(invocation.deadlineMs),
    'x-aig-inference-auth': key,
  });
  for (const name of ['accept', 'anthropic-version', 'anthropic-beta', 'idempotency-key']) {
    const value = invocation.request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Request('https://inference.internal/internal/execute', {
    method: 'POST',
    headers,
    body: invocation.body,
    signal: invocation.request.signal,
  });
}

/** No implicit fallback to the legacy provider network path. */
export async function invokeInferenceNode(env: GatewayEnv, invocation: InferenceInvocation): Promise<Response> {
  const service = configuredService(env);
  return service.fetch(buildInferenceRequest(env, invocation));
}
