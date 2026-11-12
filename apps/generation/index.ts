// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Private generation HTTP entrypoint: contract verification and endpoint dispatch.
// Non-idempotent Provider execution and response conversion live in execution.ts.

import type { ExecutionSurface } from '../../packages/contracts/execution.ts';
import { authorizeExecutionRequest, parseExecutionInvocation } from '../../packages/contracts/execution.ts';
import { withNativeSpan } from '../../packages/contracts/native-tracing.ts';
import type { ExecutionContextLike, GatewayEnv } from '../../packages/contracts/runtime.ts';
import { execute } from './execution.ts';
import { problem } from './response.ts';

const GENERATION_SURFACES: ReadonlySet<ExecutionSurface> = new Set(['images_generations']);

export async function handleGenerationCenterRequest(request: Request, env: GatewayEnv, ctx?: ExecutionContextLike): Promise<Response> {
  if (!authorizeExecutionRequest(request, env.AIG_GENERATION_AUTH_KEY, 'x-aig-generation-auth')) return problem(403, 'generation_unauthorized');
  const path = new URL(request.url).pathname;
  if (path === '/internal/health' && request.method === 'GET') {
    return new Response(JSON.stringify({ status: 'ok', center: 'generation' }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  if (path !== '/internal/execute' || request.method !== 'POST') return problem(404, 'generation_route_invalid');
  const invocation = parseExecutionInvocation(request, GENERATION_SURFACES);
  if (!invocation) return problem(400, 'generation_contract_invalid');
  return withNativeSpan(
    ctx,
    'aig.generation.execute',
    { requestId: invocation.requestId, nodeId: invocation.nodeId, model: invocation.logicalModel, center: 'generation', phase: 'execute' },
    () => execute(request, env, invocation),
  );
}

export default {
  async fetch(request: Request, env: GatewayEnv, ctx: ExecutionContextLike): Promise<Response> {
    try {
      return await handleGenerationCenterRequest(request, env, ctx);
    } catch {
      return problem(500, 'generation_internal_error');
    }
  },
};
