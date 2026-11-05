// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Private Cloudflare Service Binding target. One invocation is ONE physical
// provider attempt; retry, model selection and admission belong to AI Gateway.
// No public route is configured for this worker.

import { loadExecutionConfig } from '../config/nodes.ts';
import { collectKnownModels } from '../config/registry.ts';
import { getOAuthProvider } from '../oauth/provider-configs.ts';
import { resolveSubscriptionCredential } from '../oauth/resolve.ts';
import { BodyTooLargeError, buildTargetUrl, readBodyTextWithLimit, readBufferedReplyText } from '../protocol/http.ts';
import { withUsageStreamOptions } from '../protocol/openai.ts';
import { getProviderAdapter, streamUsageEnabled } from '../providers/registry.ts';
import { isSubscriptionNode } from '../subscription/index.ts';
import type { SubscriptionWire } from '../subscription/types.ts';
import { buildUpstreamHeadersFor, resolveUpstreamPath } from '../transport/index.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { Surface } from '../types/protocol.ts';
import type { GatewayEnv } from '../types/runtime.ts';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_DEADLINE_AHEAD_MS = 10 * 60 * 1000;
const ALLOWED_SURFACES: ReadonlySet<string> = new Set(['chat_completions', 'responses', 'messages']);

function problem(status: number, code: string, retryable = false): Response {
  return new Response(JSON.stringify({ error: { code, retryable } }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-aig-error-kind': code,
      'x-aig-retryable': String(retryable),
    },
  });
}

function equalsConstantTime(received: string, expected: string): boolean {
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const count = Math.max(a.length, b.length);
  for (let i = 0; i < count; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function authorized(request: Request, env: GatewayEnv): boolean {
  const key = env.AIG_INFERENCE_AUTH_KEY;
  if (typeof key !== 'string' || key.length < 32) return false;
  const provided = request.headers.get('x-aig-inference-auth') ?? '';
  if (provided.length < 32 || provided.length > 1024) return false;
  return equalsConstantTime(provided, key);
}

type Invocation = {
  requestId: string;
  nodeId: string;
  logicalModel: string;
  surface: Surface;
  deadlineMs: number;
};

function parseInvocation(request: Request): Invocation | null {
  if (request.headers.get('x-aig-contract-version') !== '1') return null;
  const requestId = request.headers.get('x-aig-request-id') ?? '';
  const nodeId = request.headers.get('x-aig-node-id') ?? '';
  const logicalModel = request.headers.get('x-aig-model') ?? '';
  const surface = request.headers.get('x-aig-surface') ?? '';
  const rawDeadline = request.headers.get('x-aig-deadline-ms') ?? '';
  const deadlineMs = Number(rawDeadline);
  if (!/^[a-f0-9-]{36}$/i.test(requestId)) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(nodeId)) return null;
  if (!logicalModel || logicalModel.length > 128 || /[\r\n]/.test(logicalModel)) return null;
  if (!ALLOWED_SURFACES.has(surface)) return null;
  if (!/^\d{13}$/.test(rawDeadline) || !Number.isSafeInteger(deadlineMs)) return null;
  if (deadlineMs <= Date.now() || deadlineMs > Date.now() + MAX_DEADLINE_AHEAD_MS) return null;
  return { requestId, nodeId, logicalModel, surface: surface as Surface, deadlineMs };
}

function nativeNode(configuredNodes: readonly RuntimeNode[], invocation: Invocation, env: GatewayEnv): RuntimeNode | null {
  const node = configuredNodes.find((entry) => entry.id === invocation.nodeId);
  if (!node) return null;
  if (!node.surfaces.includes(invocation.surface)) return null;
  const knownModels = collectKnownModels(configuredNodes, env);
  if (!knownModels.has(invocation.logicalModel)) return null;
  if (Object.keys(node.models).length > 0 && !Object.hasOwn(node.models, invocation.logicalModel)) return null;
  return node;
}

function forwardedRequest(request: Request): Request {
  const headers = new Headers();
  for (const name of ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'idempotency-key']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // No client or internal authentication headers survive this allowlist.
  return new Request('https://inference.internal/execute', { method: 'POST', headers });
}

async function executeNative(request: Request, env: GatewayEnv, invocation: Invocation): Promise<Response> {
  const config = loadExecutionConfig(env);
  if (!config.ready || config.hasConfigErrors) return problem(503, 'center_configuration_invalid');
  const node = nativeNode(config.nodes, invocation, env);
  if (!node) return problem(404, 'center_route_unavailable');

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return problem(415, 'center_content_type_invalid');
  const declaredSize = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_REQUEST_BYTES) return problem(413, 'center_body_too_large');

  let rawBody: string;
  let clientBody: Record<string, unknown>;
  try {
    rawBody = await readBodyTextWithLimit(request, MAX_REQUEST_BYTES);
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return problem(400, 'center_body_invalid');
    clientBody = parsed as Record<string, unknown>;
  } catch (error) {
    return problem(error instanceof BodyTooLargeError ? 413 : 400, 'center_body_invalid');
  }

  if (clientBody.model !== invocation.logicalModel) return problem(400, 'center_model_mismatch');
  if (clientBody.stream !== undefined && typeof clientBody.stream !== 'boolean') return problem(400, 'center_stream_invalid');
  const physicalModel = node.models[invocation.logicalModel] ?? invocation.logicalModel;
  const clientRequest = forwardedRequest(request);
  let outboundBody: Record<string, unknown> = clientBody;
  let mutated = physicalModel !== invocation.logicalModel;
  if (mutated) outboundBody = { ...outboundBody, model: physicalModel };
  if (invocation.surface === 'chat_completions' && outboundBody.stream === true && streamUsageEnabled(node, env)) {
    outboundBody = withUsageStreamOptions(outboundBody);
    mutated = true;
  }

  let credential = node.credential;
  let upstreamUrl: string | null = null;
  let extraHeaders: Readonly<Record<string, string>> | undefined;
  let wire: SubscriptionWire | undefined;

  if (isSubscriptionNode(node)) {
    const resolved = await resolveSubscriptionCredential(env, node);
    if (!resolved.ok) return problem(503, 'center_subscription_unavailable');
    const adapter = getProviderAdapter(node.provider).subscription;
    if (!adapter) return problem(503, 'center_subscription_unsupported');
    const prepared = adapter.prepare({
      node,
      credential: resolved,
      request: clientRequest,
      body: outboundBody,
      surface: invocation.surface,
    });
    if (!prepared) return problem(502, 'center_subscription_rejected');
    credential = resolved.token;
    if (prepared.body) {
      outboundBody = prepared.body;
      mutated = true;
    }
    upstreamUrl = prepared.upstreamUrl;
    wire = adapter.wire;
    extraHeaders = { ...(getOAuthProvider(env, node.provider)?.upstreamHeaders ?? {}), ...prepared.headers };
  }

  let url: string;
  try {
    url = upstreamUrl ?? buildTargetUrl(node.baseUrl, resolveUpstreamPath(node.protocol, invocation.surface));
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && env.AIG_CAN_USE_HTTP !== 'true') return problem(502, 'center_upstream_url_invalid');
    if (parsed.username || parsed.password) return problem(502, 'center_upstream_url_invalid');
  } catch {
    return problem(502, 'center_upstream_url_invalid');
  }

  const headers = buildUpstreamHeadersFor(
    node.protocol,
    clientRequest,
    credential,
    invocation.requestId,
    isSubscriptionNode(node) ? { auth: 'oauth', extraHeaders } : undefined,
  );
  const body = mutated ? JSON.stringify(outboundBody) : rawBody;
  const controller = new AbortController();
  const remainingMs = invocation.deadlineMs - Date.now();
  if (remainingMs <= 0) return problem(408, 'center_deadline_expired');
  const timeoutId = setTimeout(() => controller.abort(), remainingMs);
  const onAbort = () => controller.abort();
  if (request.signal.aborted) onAbort();
  else request.signal.addEventListener('abort', onAbort, { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' });
  } catch {
    return problem(
      request.signal.aborted ? 499 : 502,
      request.signal.aborted ? 'center_client_aborted' : 'center_upstream_network',
      !request.signal.aborted,
    );
  } finally {
    clearTimeout(timeoutId);
    request.signal.removeEventListener('abort', onAbort);
  }

  if (upstream.status >= 300 && upstream.status < 400) return problem(502, 'center_redirect_forbidden');
  const outgoing = new Headers({
    'cache-control': 'no-store',
    'x-aig-result': 'dispatched',
    'x-aig-upstream-status': String(upstream.status),
  });
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter && retryAfter.length <= 128) outgoing.set('retry-after', retryAfter);
  const content = upstream.headers.get('content-type');
  if (content) outgoing.set('content-type', content.slice(0, 256));

  if (wire && upstream.ok) {
    if (content?.toLowerCase().includes('text/event-stream')) {
      outgoing.set('content-type', 'text/event-stream');
      return new Response(wire.streamToNative(upstream.body, { messageId: invocation.requestId, model: physicalModel }), {
        status: upstream.status,
        headers: outgoing,
      });
    }
    let native: Record<string, unknown> | null;
    try {
      native = wire.objectToNative(JSON.parse(await readBufferedReplyText(upstream, invocation.deadlineMs)));
    } catch {
      return problem(502, 'center_subscription_reply_invalid');
    }
    if (!native) return problem(502, 'center_subscription_reply_invalid');
    outgoing.set('content-type', 'application/json');
    return new Response(JSON.stringify(native), { status: upstream.status, headers: outgoing });
  }
  // Raw body stream ownership transfers to the caller. No buffering, no
  // JSON inspection of model output, and no further provider retry here.
  return new Response(upstream.body, { status: upstream.status, headers: outgoing });
}

export async function handleInferenceCenterRequest(request: Request, env: GatewayEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!authorized(request, env)) return problem(403, 'center_unauthorized');
  if (path === '/internal/health' && request.method === 'GET') {
    return new Response(JSON.stringify({ status: 'ok', center: 'inference' }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  if (path !== '/internal/execute' || request.method !== 'POST') return problem(404, 'center_route_not_found');
  const invocation = parseInvocation(request);
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
