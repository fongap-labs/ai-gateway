// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Private Protocol Center admission. No public routes, Provider credentials,
// model selection, Tier dispatch or retries in this Worker.
import { PROTOCOL_PREFLIGHT_PATH, parseInferencePreflightInvocation } from '../../packages/contracts/conversion-preflight.ts';
import { authorizeExecutionRequest } from '../../packages/contracts/execution.ts';
import { withNativeSpan } from '../../packages/contracts/native-tracing.ts';
import type { ExecutionContextLike, GatewayEnv } from '../../packages/contracts/runtime.ts';
import { problem } from '../../packages/execution-core/response.ts';
import { handleInferencePreflight } from '../../packages/protocol-center-core/preflight.ts';

export async function handleProtocolCenterRequest(request: Request, env: GatewayEnv, ctx?: ExecutionContextLike): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!authorizeExecutionRequest(request, env.AIG_PROTOCOL_AUTH_KEY, 'x-aig-protocol-auth')) return problem(403, 'center_unauthorized');
  if (path === '/internal/health' && request.method === 'GET') {
    return new Response(JSON.stringify({ status: 'ok', center: 'protocol' }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  if (path !== PROTOCOL_PREFLIGHT_PATH || request.method !== 'POST') return problem(404, 'center_route_not_found');
  const invocation = parseInferencePreflightInvocation(request);
  if (!invocation) return problem(400, 'center_preflight_contract_invalid');
  return withNativeSpan(ctx, 'aig.protocol.preflight', { requestId: invocation.requestId, center: 'protocol', phase: 'preflight' }, () =>
    handleInferencePreflight(request, invocation),
  );
}

export default {
  async fetch(request: Request, env: GatewayEnv, ctx: ExecutionContextLike): Promise<Response> {
    try {
      return await handleProtocolCenterRequest(request, env, ctx);
    } catch {
      return problem(500, 'center_internal_error');
    }
  },
};
