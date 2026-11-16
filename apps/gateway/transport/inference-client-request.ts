import type { ExecutionInputSurface, ExecutionTransport } from '../../../packages/contracts/execution.ts';
import { buildExecutionHeaders } from '../../../packages/contracts/execution.ts';
import type { InferenceStreamBudget } from '../../../packages/contracts/inference-stream-budget.ts';
import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';
import type { Surface } from '../../../src/types/protocol.ts';

export type InferenceInvocation = {
  request: Request;
  requestId: string;
  traceparent?: string;
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
  upstreamHeadersDeadlineMs?: number;
  bufferedResponseDeadlineMs?: number;
  body: string;
  signal?: AbortSignal;
};

export type InferenceCenter = 'inference' | 'perception';

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

function buildPrivateCenterRequest(invocation: InferenceInvocation, authHeader: string, key: string, destination: 'inference' | 'protocol'): Request {
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
    authHeader,
    key,
  );
  for (const name of ['accept', 'anthropic-version', 'anthropic-beta', 'idempotency-key']) {
    const value = invocation.request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('content-length', String(new Blob([invocation.body]).size));
  return new Request(`https://${destination}.internal/internal/execute`, {
    method: 'POST',
    headers,
    body: invocation.body,
    signal: invocation.signal ?? invocation.request.signal,
  });
}

export function buildInferenceRequest(env: GatewayEnv, invocation: InferenceInvocation): Request {
  configuredInferenceService(env);
  return buildPrivateCenterRequest(invocation, 'x-aig-inference-auth', env.AIG_INFERENCE_AUTH_KEY as string, 'inference');
}

function configuredProtocolService(env: GatewayEnv): InferenceService {
  const service = env.AIG_PROTOCOL_SERVICE as InferenceService | undefined;
  const key = env.AIG_PROTOCOL_AUTH_KEY;
  if (!service || typeof service.fetch !== 'function' || typeof key !== 'string' || key.length < 32) {
    throw new InferenceCenterUnavailable();
  }
  return service;
}

export function buildProtocolExecutionRequest(env: GatewayEnv, invocation: InferenceInvocation): Request {
  configuredProtocolService(env);
  return buildPrivateCenterRequest(invocation, 'x-aig-protocol-auth', env.AIG_PROTOCOL_AUTH_KEY as string, 'protocol');
}

export async function invokeInferenceNode(env: GatewayEnv, invocation: InferenceInvocation): Promise<Response> {
  if (invocation.inputSurface && env.AIG_PROTOCOL_SERVICE !== undefined) {
    const service = configuredProtocolService(env);
    return service.fetch(buildProtocolExecutionRequest(env, invocation));
  }
  const service = configuredInferenceService(env);
  return service.fetch(buildInferenceRequest(env, invocation));
}
