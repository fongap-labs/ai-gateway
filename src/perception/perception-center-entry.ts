// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Private multimodal execution entrypoint with its own auth and Service Binding.

import { executeNative } from '../../apps/inference/execution.ts';
import { problem } from '../../apps/inference/response.ts';
import type { ExecutionSurface } from '../../packages/contracts/execution.ts';
import { authorizeExecutionRequest, parseExecutionInvocation } from '../../packages/contracts/execution.ts';
import type { GatewayEnv } from '../../packages/contracts/runtime.ts';

const ALLOWED_SURFACES: ReadonlySet<ExecutionSurface> = new Set(['chat_completions', 'responses', 'messages']);

export async function handlePerceptionCenterRequest(request: Request, env: GatewayEnv): Promise<Response> {
  if (!authorizeExecutionRequest(request, env.AIG_PERCEPTION_AUTH_KEY, 'x-aig-perception-auth')) return problem(403, 'center_unauthorized');
  if (new URL(request.url).pathname !== '/internal/execute' || request.method !== 'POST') return problem(404, 'center_route_not_found');
  const invocation = parseExecutionInvocation(request, ALLOWED_SURFACES);
  if (!invocation) return problem(400, 'center_contract_invalid');
  return executeNative(request, env, invocation, { center: 'perception' });
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    try {
      return await handlePerceptionCenterRequest(request, env);
    } catch {
      return problem(500, 'center_internal_error');
    }
  },
};
