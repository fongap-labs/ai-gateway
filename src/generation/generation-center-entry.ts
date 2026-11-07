// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Private image-generation execution. Exactly one physical provider attempt;
// the gateway alone owns authorization, routing and retry decisions.
// No public routes, provider secrets or image payloads in diagnostic logs.

import { authorizeExecutionRequest, parseExecutionInvocation } from '../../packages/contracts/execution.ts';
import type { ExecutionInvocation, ExecutionSurface } from '../../packages/contracts/execution.ts';
import { loadExecutionConfig } from '../config/nodes.ts';
import { collectKnownModels } from '../config/registry.ts';
import { BodyTooLargeError, readBodyTextBounded, readBodyTextWithLimit } from '../protocol/http.ts';
import { validateImageGenerationRequest } from '../protocol/image.ts';
import type { ImageSize, PreparedImageRequest } from '../providers/image-generation.ts';
import { getProviderAdapter } from '../providers/registry.ts';
import { extractQuotaSignal } from '../reliability/quota-signal.ts';
import { isSubscriptionNode } from '../subscription/index.ts';
import { buildUpstreamHeadersFor } from '../transport/index.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { GatewayEnv } from '../types/runtime.ts';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_NATIVE_REPLY_BYTES = 16 * 1024 * 1024;
const MAX_CONVERTED_REPLY_BYTES = 2 * 1024 * 1024;
const IMAGE_PROVIDERS = new Set(['openai-image', 'google-image', 'cloudflare-image']);

type Invocation = ExecutionInvocation;
const GENERATION_SURFACES: ReadonlySet<ExecutionSurface> = new Set(['images_generations']);

function problem(status: number, code: string, result = 'not-dispatched'): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-aig-error-kind': code,
      'x-aig-result': result,
    },
  });
}

function generationNode(nodes: readonly RuntimeNode[], invocation: Invocation, env: GatewayEnv): RuntimeNode | null {
  const node = nodes.find((candidate) => candidate.id === invocation.nodeId);
  if (!node || !IMAGE_PROVIDERS.has(node.provider) || isSubscriptionNode(node)) return null;
  if (!node.surfaces.includes('images_generations')) return null;
  if (!collectKnownModels(nodes, env).has(invocation.logicalModel)) return null;
  if (Object.keys(node.models).length > 0 && !Object.hasOwn(node.models, invocation.logicalModel)) return null;
  return node;
}

function nativeHeaders(upstream: Response): Headers {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/json;charset=UTF-8',
    'x-aig-result': 'dispatched',
    'x-aig-generation-normalized': 'true',
  });
  const quota = extractQuotaSignal('openai', upstream.headers);
  if (quota) {
    headers.set(
      'x-aig-quota-signal',
      JSON.stringify({
        remainingRequests: quota.remainingRequests,
        remainingTokens: quota.remainingTokens,
        limitRequests: quota.limitRequests,
        limitTokens: quota.limitTokens,
        resetAtMs: quota.resetAtMs,
      }),
    );
  }
  return headers;
}

async function execute(request: Request, env: GatewayEnv, invocation: Invocation): Promise<Response> {
  const cfg = loadExecutionConfig(env);
  if (!cfg.ready || cfg.hasConfigErrors) return problem(503, 'generation_config_invalid');
  const node = generationNode(cfg.nodes, invocation, env);
  if (!node) return problem(404, 'generation_node_unavailable');
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    return problem(415, 'generation_content_type_invalid');
  }
  const reportedSize = Number(request.headers.get('content-length'));
  if (Number.isFinite(reportedSize) && reportedSize > MAX_REQUEST_BYTES) return problem(413, 'generation_body_too_large');

  let body: Record<string, unknown>;
  try {
    const raw = await readBodyTextWithLimit(request, MAX_REQUEST_BYTES);
    const parsed: unknown = JSON.parse(raw);
    const message = validateImageGenerationRequest(parsed);
    if (message) return problem(400, 'generation_body_invalid');
    body = parsed as Record<string, unknown>;
  } catch (error) {
    return problem(error instanceof BodyTooLargeError ? 413 : 400, 'generation_body_invalid');
  }
  if (body.model !== invocation.logicalModel || body.stream !== undefined) return problem(400, 'generation_model_invalid');

  const adapter = getProviderAdapter(node.provider).image;
  if (!adapter) return problem(503, 'generation_adapter_missing');
  const physicalModel = node.models[invocation.logicalModel] ?? invocation.logicalModel;
  let prepared: PreparedImageRequest;
  try {
    const candidate = adapter.prepare(node.baseUrl, physicalModel, {
      prompt: body.prompt as string,
      size: (body.size ?? '1024x1024') as ImageSize,
    });
    if (!candidate) return problem(400, 'generation_provider_unsupported');
    prepared = candidate;
    const target = new URL(prepared.url);
    if ((target.protocol !== 'https:' && env.AIG_CAN_USE_HTTP !== 'true') || target.username || target.password) {
      return problem(502, 'generation_url_invalid');
    }
  } catch {
    return problem(502, 'generation_url_invalid');
  }

  const safeClientRequest = new Request('https://generation.internal/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  });
  const headers = buildUpstreamHeadersFor(node.protocol, safeClientRequest, node.credential, invocation.requestId);
  if (prepared.auth === 'google-key') {
    headers.delete('authorization');
    headers.set('x-goog-api-key', node.credential);
  }
  const controller = new AbortController();
  const remainingMs = invocation.deadlineMs - Date.now();
  if (remainingMs <= 0) return problem(408, 'generation_deadline_expired');
  const timeoutId = setTimeout(() => controller.abort(), remainingMs);
  const abort = () => controller.abort();
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(prepared.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(prepared.body),
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch {
    // A generation may have started and billed even when its headers are lost.
    // Never let the gateway replay this request on another provider.
    return problem(502, 'generation_outcome_unknown', 'attempted');
  } finally {
    clearTimeout(timeoutId);
    request.signal.removeEventListener('abort', abort);
  }

  if (upstream.status >= 300 && upstream.status < 400) return problem(502, 'generation_redirect_forbidden', 'dispatched');
  if (!upstream.ok) {
    const response = problem(upstream.status, 'generation_upstream_rejected', 'dispatched');
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter && retryAfter.length <= 128) response.headers.set('retry-after', retryAfter);
    return response;
  }
  const replyHeaders = nativeHeaders(upstream);
  if (node.provider === 'openai-image') {
    const contentLength = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_NATIVE_REPLY_BYTES) {
      return problem(502, 'generation_reply_too_large', 'dispatched');
    }
    // OpenAI already returns the required public JSON schema.
    return new Response(upstream.body, { status: 200, headers: replyHeaders });
  }

  try {
    const payload = await readBodyTextBounded(upstream, MAX_CONVERTED_REPLY_BYTES, invocation.deadlineMs);
    if (payload.isTruncated) return problem(502, 'generation_reply_too_large', 'dispatched');
    const image = adapter.extract(JSON.parse(payload.text));
    if (!image) return problem(502, 'generation_reply_invalid', 'dispatched');
    return new Response(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: image }] }), {
      status: 200,
      headers: replyHeaders,
    });
  } catch {
    return problem(502, 'generation_reply_invalid', 'dispatched');
  }
}

export async function handleGenerationCenterRequest(request: Request, env: GatewayEnv): Promise<Response> {
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
  return execute(request, env, invocation);
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    try {
      return await handleGenerationCenterRequest(request, env);
    } catch {
      return problem(500, 'generation_internal_error');
    }
  },
};
