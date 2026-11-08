// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Private inference HTTP entrypoint: contract authentication, endpoint dispatch.
// Provider selection, OAuth resolution and the single physical fetch live in
// execution.ts; do not add a second scheduler here.

import { INFERENCE_PREFLIGHT_PATH, parseInferencePreflightInvocation } from '../../packages/contracts/conversion-preflight.ts';
import type { ExecutionSurface } from '../../packages/contracts/execution.ts';
import { authorizeExecutionRequest, parseExecutionInvocation } from '../../packages/contracts/execution.ts';
import type { GatewayEnv } from '../../packages/contracts/runtime.ts';
import { executeNative } from './execution.ts';
import { handleInferencePreflight } from './preflight.ts';
import { problem } from './response.ts';

const ALLOWED_SURFACES: ReadonlySet<ExecutionSurface> = new Set(['chat_completions', 'responses', 'messages']);

export async function handleInferenceCenterRequest(request: Request, env: GatewayEnv): Promise<Response> {
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
    return handleInferencePreflight(request, preflight);
  }
  if (path !== '/internal/execute' || request.method !== 'POST') return problem(404, 'center_route_not_found');
  const invocation = parseExecutionInvocation(request, ALLOWED_SURFACES);
  if (!invocation) return problem(400, 'center_contract_invalid');
  return executeNative(request, env, invocation);
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    try {
      return await handleInferenceCenterRequest(request, env);
    } catch {
      return problem(500, 'center_internal_error');
    }
  },
};
