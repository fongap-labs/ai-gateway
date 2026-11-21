import { INFERENCE_PREFLIGHT_PATH, parseInferencePreflightInvocation } from '../../packages/contracts/conversion-preflight.ts';
import type { ExecutionSurface } from '../../packages/contracts/execution.ts';
import { INFERRED_CREDENTIAL_GROUPS_HEADER, encodeInferredCredentialGroups } from '../../packages/contracts/credential-groups.ts';
import { loadExecutionConfig } from '../../packages/config-core/nodes.ts';
import { authorizeExecutionRequest, parseExecutionInvocation } from '../../packages/contracts/execution.ts';
import { withNativeSpan } from '../../packages/contracts/native-tracing.ts';
import type { ExecutionContextLike, GatewayEnv } from '../../packages/contracts/runtime.ts';
import { executeNative } from '../../packages/execution-core/native.ts';
import { problem } from '../../packages/execution-core/response.ts';
import { handleInferencePreflight } from './preflight.ts';

const ALLOWED_SURFACES: ReadonlySet<ExecutionSurface> = new Set(['chat_completions', 'responses', 'messages']);

export async function handleInferenceCenterRequest(request: Request, env: GatewayEnv, ctx?: ExecutionContextLike): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!authorizeExecutionRequest(request, env.AIG_INFERENCE_AUTH_KEY, 'x-aig-inference-auth')) return problem(403, 'center_unauthorized');
  if (path === '/internal/health' && request.method === 'GET') {
    return new Response(JSON.stringify({ status: 'ok', center: 'inference' }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  if (path === INFERENCE_PREFLIGHT_PATH && request.method === 'POST') {
    const preflight = parseInferencePreflightInvocation(request);
    if (!preflight) return problem(400, 'center_preflight_contract_invalid');
    return withNativeSpan(ctx, 'aig.inference.preflight', { requestId: preflight.requestId, center: 'inference', phase: 'preflight' }, () =>
      handleInferencePreflight(request, preflight),
    );
  }
  if (path !== '/internal/execute' || request.method !== 'POST') return problem(404, 'center_route_not_found');
  const invocation = parseExecutionInvocation(request, ALLOWED_SURFACES);
  if (!invocation) return problem(400, 'center_contract_invalid');
  return withNativeSpan(
    ctx,
    'aig.inference.execute',
    { requestId: invocation.requestId, nodeId: invocation.nodeId, model: invocation.logicalModel, center: 'inference', phase: 'execute' },
    async () => {
      const response = await executeNative(request, env, invocation);
      const groups = encodeInferredCredentialGroups(loadExecutionConfig(env).nodes);
      if (groups !== null) response.headers.set(INFERRED_CREDENTIAL_GROUPS_HEADER, groups);
      return response;
    },
  );
}

export default {
  async fetch(request: Request, env: GatewayEnv, ctx: ExecutionContextLike): Promise<Response> {
    try {
      return await handleInferenceCenterRequest(request, env, ctx);
    } catch {
      return problem(500, 'center_internal_error');
    }
  },
};
