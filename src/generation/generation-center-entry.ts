// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Private image-generation execution. Exactly one physical provider attempt;
// the gateway alone owns authorization, routing and retry decisions.
// No public routes, provider secrets or image payloads in diagnostic logs.

import { loadExecutionConfig } from '../config/nodes.ts';
import { collectKnownModels } from '../config/registry.ts';
import { readBodyTextBounded, readBodyTextWithLimit, BodyTooLargeError } from '../protocol/http.ts';
import { validateImageGenerationRequest } from '../protocol/image.ts';
import type { ImageSize } from '../providers/image-generation.ts';
import { getProviderAdapter } from '../providers/registry.ts';
import { extractQuotaSignal } from '../reliability/quota-signal.ts';
import { isSubscriptionNode } from '../subscription/index.ts';
import { buildUpstreamHeadersFor } from '../transport/index.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { GatewayEnv } from '../types/runtime.ts';

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_NATIVE_REPLY_BYTES = 16 * 1024 * 1024;
const MAX_CONVERTED_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_DEADLINE_AHEAD_MS = 10 * 60 * 1000;
const IMAGE_PROVIDERS = new Set(['openai-image', 'google-image', 'cloudflare-image']);

type Invocation = {
  requestId: string;
  nodeId: string;
  logicalModel: string;
  deadlineMs: number;
};

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

function constantTimeMatch(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function authorized(request: Request, env: GatewayEnv): boolean {
  const key = env.AIG_GENERATION_AUTH_KEY;
  const supplied = request.headers.get('x-aig-generation-auth') ?? '';
  return typeof key === 'string' && key.length >= 32 && supplied.length >= 32 && supplied.length <= 1024 && constantTimeMatch(supplied, key);
}

function invocationOf(request: Request): Invocation | null {
  if (request.headers.get('x-aig-contract-version') !== '1') return null;
  if (request.headers.get('x-aig-surface') !== 'images_generations') return null;
  const requestId = request.headers.get('x-aig-request-id') ?? '';
  const nodeId = request.headers.get('x-aig-node-id') ?? '';
  const logicalModel = request.headers.get('x-aig-model') ?? '';
  const rawDeadline = request.headers.get('x-aig-deadline-ms') ?? '';
  const deadlineMs = Number(rawDeadline);
  if (!/^[a-f0-9-]{36}$/i.test(requestId) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(nodeId)) return null;
  if (!logicalModel || logicalModel.length > 128 || /[\r\n]/.test(logicalModel)) return null;
  if (!/^\d{13}$/.test(rawDeadline) || !Number.isSafeInteger(deadlineMs)) return null;
  if (deadlineMs <= Date.now() || deadlineMs > Date.now() + MAX_DEADLINE_AHEAD_MS) return null;
  return { requestId, nodeId, logicalModel, deadlineMs };
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
  let prepared;
  try {
    prepared = adapter.prepare(node.baseUrl, physicalModel, {
      prompt: body.prompt as string,
      size: (body.size ?? '1024x1024') as ImageSize,
    });
    if (!prepared) return problem(400, 'generation_provider_unsupported');
    const target = new URL(prepared.url);
    if ((target.protocol !== 'https:' && env.AIG_CAN_USE_HTTP !== 'true') || target.username || target.password) {
      return problem(502, 'generation_url_invalid');
    }
  } catch {
    return problem(502, 'generation_url_invalid');
  }

  const safeClientRequest = new Request('https://generation.internal/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
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
  if (!authorized(request, env)) return problem(403, 'generation_unauthorized');
  const path = new URL(request.url).pathname;
  if (path === '/internal/health' && request.method === 'GET') {
    return new Response(JSON.stringify({ status: 'ok', center: 'generation' }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  if (path !== '/internal/execute' || request.method !== 'POST') return problem(404, 'generation_route_invalid');
  const invocation = invocationOf(request);
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
