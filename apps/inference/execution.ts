// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// One physical inference Provider attempt only. No client-level admission,
// model family retries, Tier scheduling or public routing in this module.

import type { ExecutionInputSurface, ExecutionInvocation } from '../../packages/contracts/execution.ts';
import { highRiskSemanticLoss } from '../../packages/conversion-core/fidelity-policy.ts';
import type { IrProtocol } from '../../packages/conversion-core/ir.ts';
import { ConversionError } from '../../packages/conversion-core/validation.ts';
import { loadExecutionConfig } from '../../src/config/nodes.ts';
import { collectKnownModels } from '../../src/config/registry.ts';
import { getOAuthProvider } from '../../src/oauth/provider-configs.ts';
import { resolveSubscriptionCredential } from '../../src/oauth/resolve.ts';
import { BodyTooLargeError, buildTargetUrl, readBodyTextWithLimit, readBufferedReplyText } from '../../src/protocol/http.ts';
import { withUsageStreamOptions } from '../../src/protocol/openai.ts';
import { getProviderAdapter, streamUsageEnabled } from '../../src/providers/registry.ts';
import { extractQuotaSignal } from '../../src/reliability/quota-signal.ts';
import { isSubscriptionNode } from '../../src/subscription/index.ts';
import type { SubscriptionWire } from '../../src/subscription/types.ts';
import { buildUpstreamHeadersFor, resolveUpstreamPath } from '../../src/transport/index.ts';
import type { RuntimeNode } from '../../src/types/node.ts';
import type { GatewayEnv } from '../../src/types/runtime.ts';
import { convertMatrixRequest, isMatrixPair } from './conversion/request.ts';
import { problem } from './response.ts';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
type Invocation = ExecutionInvocation;

function protocolForSurface(surface: ExecutionInputSurface | Invocation['surface']): IrProtocol | null {
  switch (surface) {
    case 'chat_completions':
      return 'openai_chat';
    case 'responses':
      return 'openai_responses';
    case 'messages':
      return 'anthropic';
    default:
      return null;
  }
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

export async function executeNative(request: Request, env: GatewayEnv, invocation: Invocation): Promise<Response> {
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
  let outboundBody: Record<string, unknown> = clientBody;
  let isMutated = false;
  if (invocation.inputSurface) {
    const from = protocolForSurface(invocation.inputSurface);
    const to = protocolForSurface(invocation.surface);
    const matchesNode = node.protocol === 'anthropic' ? invocation.surface === 'messages' : invocation.surface !== 'messages';
    if (!matchesNode || !from || !to || !isMatrixPair(from, to)) return problem(400, 'center_conversion_route_invalid');
    try {
      // Independently validate and convert the original client shape BEFORE
      // any physical Provider attempt. Gateway's dry-run is not trusted.
      const converted = convertMatrixRequest(from, to, clientBody, { isNonstreamPreferred: invocation.preferNonstream === true });
      if (highRiskSemanticLoss(converted).length > 0) return problem(422, 'center_conversion_semantic_loss');
      outboundBody = converted.body;
      isMutated = true;
    } catch (error) {
      if (error instanceof ConversionError) return problem(400, 'center_conversion_invalid');
      throw error;
    }
  }
  const physicalModel = node.models[invocation.logicalModel] ?? invocation.logicalModel;
  const clientRequest = forwardedRequest(request);
  if (physicalModel !== invocation.logicalModel) {
    outboundBody = { ...outboundBody, model: physicalModel };
    isMutated = true;
  }
  if (invocation.surface === 'chat_completions' && outboundBody.stream === true && streamUsageEnabled(node, env)) {
    outboundBody = withUsageStreamOptions(outboundBody);
    isMutated = true;
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
      isMutated = true;
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
  const body = isMutated ? JSON.stringify(outboundBody) : rawBody;
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
    if (request.signal.aborted) return problem(499, 'center_client_aborted');
    // A provider fetch was attempted, but no response headers were received.
    // The gateway may apply its existing bounded network-failure rotation.
    const response = problem(502, 'center_upstream_network', true);
    response.headers.set('x-aig-result', 'attempted');
    return response;
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
  // Provider quota markers are normalized here, not forwarded raw. Unknown
  // values remain unknown; this hint is never a globally consistent counter.
  const quota = extractQuotaSignal(node.protocol, upstream.headers);
  if (quota) {
    outgoing.set(
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
