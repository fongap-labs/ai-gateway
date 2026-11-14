// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// One physical inference Provider attempt only. No client-level admission,
// model family retries, Tier scheduling or public routing in this module.

import { loadExecutionConfig } from '../config-core/nodes.ts';
import { collectKnownModels, modelRegistryEntry, resolvePhysicalModel } from '../config-core/registry.ts';
import { getLimits } from '../config-core/timeouts.ts';
import { EXECUTION_ERROR_CODE, EXECUTION_WIRE_RESULT, type ExecutionInvocation } from '../contracts/execution.ts';
import { hasImageInput } from '../contracts/image-input.ts';
import { getProviderProfile } from '../contracts/provider-profiles.ts';
import { streamUsageEnabled } from '../contracts/provider-usage.ts';
import { extractQuotaSignal } from '../contracts/quota-signal.ts';
import type { GatewayEnv } from '../contracts/runtime.ts';
import type { RuntimeNode } from '../contracts/runtime-node.ts';
import { childTraceparent } from '../contracts/trace-context.ts';
import { prepareProtocolRequest } from '../conversion-core/matrix/request-protocol-adapter.ts';
import { convertPrivateMatrixResponse } from '../protocol-center-core/response.ts';
import { withUsageStreamOptions } from '../protocol-core/openai.ts';
import { createBodyAdmissionPool } from '../transport/body-admission.ts';
import { BodyTooLargeError, buildTargetUrl, readBodyTextWithLimit } from '../transport/http.ts';
import { dispatchProviderAttempt } from '../transport/provider-attempt.ts';
import { buildProviderForwardRequest } from '../transport/provider-forward-request.ts';
import { buildUpstreamHeadersFor, resolveUpstreamPath } from '../transport/provider-routing.ts';
import { preDispatchProblem, problem } from './response.ts';

// The physical center uses the same clamped maximum as Gateway preflight.
// Its own memory pool remains separate, even in an in-process integration test.
const centerBodyPool = createBodyAdmissionPool();
type Invocation = ExecutionInvocation;
type ExecutionOptions = { center?: 'perception' };

function nativeNode(configuredNodes: readonly RuntimeNode[], invocation: Invocation, knownModels: ReadonlySet<string>): RuntimeNode | null {
  const node = configuredNodes.find((entry) => entry.id === invocation.nodeId);
  if (!node) return null;
  if (!node.surfaces.includes(invocation.surface)) return null;
  if (!knownModels.has(invocation.logicalModel)) return null;
  if (!resolvePhysicalModel(node, invocation.logicalModel, knownModels)) return null;
  return node;
}

export async function executeNative(request: Request, env: GatewayEnv, invocation: Invocation, options: ExecutionOptions = {}): Promise<Response> {
  const config = loadExecutionConfig(env);
  // Keep serving strictly validated nodes in a degraded configuration, as the
  // former Gateway did. Invalid nodes and missing secrets are already excluded
  // by loadExecutionConfig; an entirely unusable center still fails closed.
  if (!config.ready) return problem(503, 'center_configuration_invalid');
  const knownModels = collectKnownModels(config.nodes, env);
  const node = nativeNode(config.nodes, invocation, knownModels);
  // This node is absent from the center's strictly validated physical pool.
  // Tell Gateway no Provider execution occurred so it may try another
  // metadata-visible node without falsely marking the Provider unhealthy.
  if (!node) return preDispatchProblem(404, EXECUTION_ERROR_CODE.CENTER_ROUTE_UNAVAILABLE);

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return problem(415, 'center_content_type_invalid');
  const maxRequestBytes = getLimits(env).maxBodyBytes;
  const rawLength = request.headers.get('content-length');
  const declaredSize = rawLength === null ? 0 : Number(rawLength);
  if (rawLength !== null && (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(declaredSize))) {
    return problem(400, 'center_body_length_invalid');
  }
  if (declaredSize > maxRequestBytes) return problem(413, 'center_body_too_large');

  // The private center owns a separate isolate budget. Unknown lengths are
  // charged the full read ceiling, so chunked uploads cannot evade admission.
  const releaseBody = centerBodyPool.admit(declaredSize, maxRequestBytes);
  if (!releaseBody) {
    const rejected = problem(503, EXECUTION_ERROR_CODE.CENTER_BODY_BUDGET_EXHAUSTED, true);
    rejected.headers.set('retry-after', '1');
    return rejected;
  }
  try {
    return await executeAdmittedNative(request, env, invocation, node, maxRequestBytes, options, knownModels);
  } finally {
    releaseBody();
  }
}

async function executeAdmittedNative(
  request: Request,
  env: GatewayEnv,
  invocation: Invocation,
  node: RuntimeNode,
  maxRequestBytes: number,
  options: ExecutionOptions,
  knownModels: ReadonlySet<string>,
): Promise<Response> {
  let rawBody: string;
  let clientBody: Record<string, unknown>;
  try {
    rawBody = await readBodyTextWithLimit(request, maxRequestBytes);
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return problem(400, 'center_body_invalid');
    clientBody = parsed as Record<string, unknown>;
  } catch (error) {
    return problem(error instanceof BodyTooLargeError ? 413 : 400, 'center_body_invalid');
  }

  // Only the Inference execution ticket can accept a prepared protocol request.
  if (options.center === 'perception' && invocation.preparedRequest) return problem(400, 'center_prepared_request_not_allowed');
  if (options.center === 'perception') {
    const visionDeclared = modelRegistryEntry(env, invocation.logicalModel).catalog.capabilities.vision === true;
    if (!hasImageInput(clientBody) || !visionDeclared || !getProviderProfile(node.provider).imageInput) {
      return preDispatchProblem(404, EXECUTION_ERROR_CODE.CENTER_ROUTE_UNAVAILABLE);
    }
  }

  if (clientBody.model !== invocation.logicalModel) return problem(400, 'center_model_mismatch');
  if (clientBody.stream !== undefined && typeof clientBody.stream !== 'boolean') return problem(400, 'center_stream_invalid');
  // v6 is exclusively a non-streaming public reply, even if the physical
  // upstream is later forced into SSE by Matrix conversion.
  if (invocation.returnObject && clientBody.stream === true && !invocation.preparedRequest) return problem(400, 'center_stream_invalid');
  // v4 is solely for real streaming requests; never synthesize an object
  // protocol response under a private framed-stream ticket.
  if (invocation.returnStream && (clientBody.stream !== true || !invocation.inputSurface || !invocation.displayModel))
    return problem(400, 'center_stream_invalid');
  let outboundBody: Record<string, unknown> = clientBody;
  let isMutated = false;
  if (invocation.inputSurface) {
    const matchesNode = node.protocol === 'anthropic' ? invocation.surface === 'messages' : invocation.surface !== 'messages';
    if (!matchesNode) return problem(400, 'center_conversion_route_invalid');
    // Run the same pure adapter at the private dispatch boundary, regardless
    // of any Gateway-side feasibility/preflight decision.
    if (!invocation.preparedRequest) {
      const prepared = prepareProtocolRequest(clientBody, invocation.inputSurface, invocation.surface, invocation.preferNonstream === true);
      if (!prepared.ok) return problem(prepared.status, prepared.code);
      outboundBody = prepared.body;
      isMutated = prepared.converted;
    } else {
      // A private v7 ticket proves Protocol Center already prepared the body.
      // Preserve reply conversion below without charging twice for request conversion.
      isMutated = true;
    }
  }
  // Enforce the mapping again at the physical dispatch boundary. A missing,
  // wildcard, or identity mapping must never send the public alias upstream.
  const physicalModel = resolvePhysicalModel(node, invocation.logicalModel, knownModels);
  if (!physicalModel) return preDispatchProblem(404, EXECUTION_ERROR_CODE.CENTER_ROUTE_UNAVAILABLE);
  const clientRequest = buildProviderForwardRequest(request);
  outboundBody = { ...outboundBody, model: physicalModel };
  isMutated = true;
  if (invocation.surface === 'chat_completions' && outboundBody.stream === true && streamUsageEnabled(node, env)) {
    outboundBody = withUsageStreamOptions(outboundBody);
    isMutated = true;
  }

  const credential = node.credential;

  let url: string;
  try {
    url = buildTargetUrl(node.baseUrl, resolveUpstreamPath(node.protocol, invocation.surface));
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && env.AIG_CAN_USE_HTTP !== 'true') return problem(502, 'center_upstream_url_invalid');
    if (parsed.username || parsed.password) return problem(502, 'center_upstream_url_invalid');
  } catch {
    return problem(502, 'center_upstream_url_invalid');
  }

  const headers = buildUpstreamHeadersFor(node.protocol, clientRequest, credential, invocation.requestId);
  const providerTraceparent = childTraceparent(request.headers.get('traceparent'), invocation.requestId);
  if (providerTraceparent) headers.set('traceparent', providerTraceparent);
  const body = isMutated ? JSON.stringify(outboundBody) : rawBody;
  const upstreamHeadersDeadlineMs = Math.min(invocation.upstreamHeadersDeadlineMs ?? invocation.deadlineMs, invocation.deadlineMs);
  const attempt = await dispatchProviderAttempt({ url, headers, body, signal: request.signal, upstreamHeadersDeadlineMs });
  if (attempt.failure) return attempt.failure;
  const upstream = attempt.upstream;

  if (upstream.status >= 300 && upstream.status < 400) return problem(502, 'center_redirect_forbidden');
  const outgoing = new Headers({
    'cache-control': 'no-store',
    'x-aig-result': EXECUTION_WIRE_RESULT.DISPATCHED,
    'x-aig-upstream-status': String(upstream.status),
  });
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter && retryAfter.length <= 128) outgoing.set('retry-after', retryAfter);
  const content = upstream.headers.get('content-type');
  if (content) outgoing.set('content-type', content.slice(0, 256));
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
  return convertPrivateMatrixResponse(upstream, invocation, clientBody, env, request.signal, outgoing);
}
