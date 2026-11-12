// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Private multimodal execution entrypoint with its own auth and Service Binding.

import type { ExecutionSurface } from '../../packages/contracts/execution.ts';
import { authorizeExecutionRequest, parseExecutionInvocation } from '../../packages/contracts/execution.ts';
import { withNativeSpan } from '../../packages/contracts/native-tracing.ts';
import type { ExecutionContextLike, GatewayEnv } from '../../packages/contracts/runtime.ts';
import { executeNative } from '../inference/execution.ts';
import { problem } from '../inference/response.ts';

const ALLOWED_SURFACES: ReadonlySet<ExecutionSurface> = new Set(['chat_completions', 'responses', 'messages']);

export async function handlePerceptionCenterRequest(request: Request, env: GatewayEnv, ctx?: ExecutionContextLike): Promise<Response> {
  if (!authorizeExecutionRequest(request, env.AIG_PERCEPTION_AUTH_KEY, 'x-aig-perception-auth')) return problem(403, 'center_unauthorized');
  if (new URL(request.url).pathname !== '/internal/execute' || request.method !== 'POST') return problem(404, 'center_route_not_found');
  const invocation = parseExecutionInvocation(request, ALLOWED_SURFACES);
  if (!invocation) return problem(400, 'center_contract_invalid');
  return withNativeSpan(
    ctx,
    'aig.perception.execute',
    { requestId: invocation.requestId, nodeId: invocation.nodeId, model: invocation.logicalModel, center: 'perception', phase: 'execute' },
    () => executeNative(request, env, invocation, { center: 'perception' }),
  );
}

export default {
  async fetch(request: Request, env: GatewayEnv, ctx: ExecutionContextLike): Promise<Response> {
    try {
      return await handlePerceptionCenterRequest(request, env, ctx);
    } catch {
      return problem(500, 'center_internal_error');
    }
  },
};
