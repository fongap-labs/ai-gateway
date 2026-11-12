// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Perception has an independently owned Service Binding and authentication key.

import type { ExecutionTransport } from '../../../packages/contracts/execution.ts';
import { buildExecutionHeaders } from '../../../packages/contracts/execution.ts';
import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import type { InferenceInvocation } from './inference-client-request.ts';

export class PerceptionCenterUnavailable extends Error {
  constructor() {
    super('Private perception center is not configured.');
    this.name = 'PerceptionCenterUnavailable';
  }
}

function configuredPerceptionService(env: GatewayEnv): ExecutionTransport {
  const service = env.AIG_PERCEPTION_SERVICE as ExecutionTransport | undefined;
  const key = env.AIG_PERCEPTION_AUTH_KEY;
  if (!service || typeof service.fetch !== 'function' || typeof key !== 'string' || key.length < 32) {
    throw new PerceptionCenterUnavailable();
  }
  return service;
}

export function buildPerceptionRequest(env: GatewayEnv, invocation: InferenceInvocation): Request {
  configuredPerceptionService(env);
  const key = env.AIG_PERCEPTION_AUTH_KEY as string;
  const headers = buildExecutionHeaders(
    {
      requestId: invocation.requestId,
      traceparent: invocation.traceparent,
      nodeId: invocation.node.id,
      logicalModel: invocation.logicalModel,
      surface: invocation.surface,
      deadlineMs: invocation.deadlineMs,
      upstreamHeadersDeadlineMs: invocation.upstreamHeadersDeadlineMs,
      bufferedResponseDeadlineMs: invocation.bufferedResponseDeadlineMs,
      inputSurface: invocation.inputSurface,
      preferNonstream: invocation.preferNonstream,
      returnObject: invocation.returnObject,
      returnStream: invocation.returnStream,
      streamBudget: invocation.streamBudget,
      displayModel: invocation.displayModel,
    },
    'x-aig-perception-auth',
    key,
  );
  for (const name of ['accept', 'anthropic-version', 'anthropic-beta', 'idempotency-key']) {
    const value = invocation.request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('content-length', String(new Blob([invocation.body]).size));
  return new Request('https://perception.internal/internal/execute', {
    method: 'POST',
    headers,
    body: invocation.body,
    signal: invocation.signal ?? invocation.request.signal,
  });
}

export async function invokePerceptionNode(env: GatewayEnv, invocation: InferenceInvocation): Promise<Response> {
  return configuredPerceptionService(env).fetch(buildPerceptionRequest(env, invocation));
}
