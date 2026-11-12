// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Authenticated, opt-in production Service Binding probe. There are no Provider
// calls or credentials in the response. Perception uses a deliberately invalid
// execution contract because it has no /internal/health route.

import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import { resolveBuildSha } from '../../../src/observability/diagnostic-endpoints.ts';
import { corsHeaders } from '../../../src/protocol/http.ts';

type Status = 'ok' | 'missing-binding' | 'missing-key' | 'unauthorized' | 'unexpected-response' | 'auth-not-enforced' | 'transport-error';
type PrivateBinding = { fetch(request: Request): Promise<Response> };
const SPECS = [
  { name: 'inference', binding: 'AIG_INFERENCE_SERVICE', secret: 'AIG_INFERENCE_AUTH_KEY', header: 'x-aig-inference-auth', path: '/internal/health', method: 'GET', success: 200 },
  { name: 'perception', binding: 'AIG_PERCEPTION_SERVICE', secret: 'AIG_PERCEPTION_AUTH_KEY', header: 'x-aig-perception-auth', path: '/internal/execute', method: 'POST', success: 400 },
  { name: 'generation', binding: 'AIG_GENERATION_SERVICE', secret: 'AIG_GENERATION_AUTH_KEY', header: 'x-aig-generation-auth', path: '/internal/health', method: 'GET', success: 200 },
] as const;

function isBinding(value: unknown): value is PrivateBinding {
  return value !== null && typeof value === 'object' && 'fetch' in value && typeof value.fetch === 'function';
}

function isExpectedPositive(body: unknown, name: string): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const data = body as Record<string, unknown>;
  if (name !== 'perception') return data.status === 'ok' && data.center === name;
  const error = data.error;
  return error !== null && typeof error === 'object' && !Array.isArray(error) &&
    (error as Record<string, unknown>).code === 'center_contract_invalid';
}

async function checkCenter(env: GatewayEnv, spec: (typeof SPECS)[number]): Promise<Status> {
  const binding = env[spec.binding];
  if (!isBinding(binding)) return 'missing-binding';
  const secret = env[spec.secret];
  if (typeof secret !== 'string' || secret.length < 32) return 'missing-key';
  const url = `https://${spec.name}.internal${spec.path}`;
  const makeRequest = (credential: string) => new Request(url, {
    method: spec.method,
    headers: { [spec.header]: credential },
    signal: AbortSignal.timeout(2500),
  });
  try {
    // Authenticated request is guaranteed to terminate before execution:
    // GET /internal/health or POST /internal/execute without contract headers.
    const authorized = await binding.fetch(makeRequest(secret));
    if (authorized.status === 403) return 'unauthorized';
    if (authorized.status !== spec.success) return 'unexpected-response';
    const body: unknown = await authorized.json().catch(() => null);
    if (!isExpectedPositive(body, spec.name)) return 'unexpected-response';
    // A deliberately short credential must fail authorization regardless of
    // the installed secret value; it must never reach Provider execution.
    const rejected = await binding.fetch(makeRequest('invalid'));
    if (rejected.status !== 403) return 'auth-not-enforced';
    return 'ok';
  } catch {
    return 'transport-error';
  }
}

export async function privateCenterProbeResponse(request: Request, env: GatewayEnv, requestId: string): Promise<Response> {
  const statuses = await Promise.all(SPECS.map(async (spec) => [spec.name, await checkCenter(env, spec)] as const));
  const centers = Object.fromEntries(statuses);
  const ready = statuses.every(([, status]) => status === 'ok');
  return new Response(JSON.stringify({
    build: resolveBuildSha(env),
    ready,
    status: ready ? 'ok' : 'degraded',
    centers,
  }), {
    status: ready ? 200 : 503,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      ...corsHeaders(request, env),
    },
  });
}
