// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Private image executor request. No implicit provider fallback on binding
// or authentication errors: these operations may have already been billed.

import type { ExecutionTransport } from '../../../packages/contracts/execution.ts';
import { buildExecutionHeaders } from '../../../packages/contracts/execution.ts';
import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';

type GenerationService = ExecutionTransport;

export type GenerationInvocation = {
  request: Request;
  requestId: string;
  node: RuntimeNode;
  logicalModel: string;
  deadlineMs: number;
  body: string;
  signal?: AbortSignal;
};

export class GenerationCenterUnavailable extends Error {
  constructor() {
    super('Private image-generation center is not available.');
    this.name = 'GenerationCenterUnavailable';
  }
}

function serviceOf(env: GatewayEnv): GenerationService {
  const service = env.AIG_GENERATION_SERVICE as GenerationService | undefined;
  const key = env.AIG_GENERATION_AUTH_KEY;
  if (!service || typeof service.fetch !== 'function' || typeof key !== 'string' || key.length < 32) {
    throw new GenerationCenterUnavailable();
  }
  return service;
}

export function buildGenerationRequest(env: GatewayEnv, invocation: GenerationInvocation): Request {
  serviceOf(env);
  const headers = buildExecutionHeaders(
    {
      requestId: invocation.requestId,
      nodeId: invocation.node.id,
      logicalModel: invocation.logicalModel,
      surface: 'images_generations',
      deadlineMs: invocation.deadlineMs,
    },
    'x-aig-generation-auth',
    env.AIG_GENERATION_AUTH_KEY as string,
  );
  return new Request('https://generation.internal/internal/execute', {
    method: 'POST',
    headers,
    body: invocation.body,
    signal: invocation.signal ?? invocation.request.signal,
  });
}

export async function invokeGenerationNode(env: GatewayEnv, invocation: GenerationInvocation): Promise<Response> {
  const service = serviceOf(env);
  return service.fetch(buildGenerationRequest(env, invocation));
}
