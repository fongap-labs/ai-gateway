// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// One physical inference Provider attempt only. No client-level admission,
// model family retries, Tier scheduling or public routing in this module.

import { loadExecutionConfig } from '../../packages/config-core/nodes.ts';
import { collectKnownModels, modelRegistryEntry } from '../../packages/config-core/registry.ts';
import { getLimits } from '../../packages/config-core/timeouts.ts';
import {
  EXECUTION_ERROR_CODE,
  EXECUTION_WIRE_RESULT,
  type ExecutionInvocation,
  INFERENCE_TRANSLATED_OBJECT_FORMAT,
} from '../../packages/contracts/execution.ts';
import { hasImageInput } from '../../packages/contracts/image-input.ts';
import { getProviderProfile } from '../../packages/contracts/provider-profiles.ts';
import { streamUsageEnabled } from '../../packages/contracts/provider-usage.ts';
import { extractQuotaSignal } from '../../packages/contracts/quota-signal.ts';
import type { GatewayEnv } from '../../packages/contracts/runtime.ts';
import type { RuntimeNode } from '../../packages/contracts/runtime-node.ts';
import { childTraceparent } from '../../packages/contracts/trace-context.ts';
import { ConversionBudgetStop } from '../../packages/conversion-core/budget.ts';
import { conversionBudgetErrorChunk } from '../../packages/conversion-core/budget-error.ts';
import { highRiskSemanticLoss } from '../../packages/conversion-core/fidelity-policy.ts';
import type { IrProtocol } from '../../packages/conversion-core/ir.ts';
import { buildFramedMatrixObjectFallback, buildFramedMatrixResponse } from '../../packages/conversion-core/matrix/framed-stream.ts';
import { convertMatrixRequest, isMatrixPair } from '../../packages/conversion-core/matrix/request.ts';
import { replyFromNativeObject, replyToObject } from '../../packages/conversion-core/matrix/response.ts';
import { collectMatrixObject, type MatrixStreamBudget } from '../../packages/conversion-core/matrix/stream.ts';
import { protocolForSurface } from '../../packages/conversion-core/surface-protocol.ts';
import { ConversionError } from '../../packages/conversion-core/validation.ts';
import { estimateAnthropicInputTokens } from '../../packages/protocol-core/anthropic.ts';
import { withUsageStreamOptions } from '../../packages/protocol-core/openai.ts';
import { createBodyAdmissionPool } from '../../packages/transport/body-admission.ts';
import { BodyTooLargeError, buildTargetUrl, readBodyTextWithLimit, readBufferedReplyText } from '../../packages/transport/http.ts';
import { dispatchProviderAttempt } from '../../packages/transport/provider-attempt.ts';
import { buildProviderForwardRequest } from '../../packages/transport/provider-forward-request.ts';
import { buildUpstreamHeadersFor, resolveUpstreamPath } from '../../packages/transport/provider-routing.ts';
import { preDispatchProblem, problem } from './response.ts';

// The physical center uses the same clamped maximum as Gateway preflight.
// Its own memory pool remains separate, even in an in-process integration test.
const centerBodyPool = createBodyAdmissionPool();
type Invocation = ExecutionInvocation;
type ExecutionOptions = { center?: 'perception' };

// Only authenticated v5 stream tickets carry explicit, validated budgets.
// v4 streams remain byte-for-byte unchanged and cannot silently inherit one.
function streamFramingOptions(invocation: Invocation, clientProtocol: IrProtocol): { model?: string; budget?: MatrixStreamBudget } {
  if (!invocation.streamBudget) return { model: invocation.displayModel };
  const { cfg, mode } = invocation.streamBudget;
  return {
    model: invocation.displayModel,
    budget: {
      cfg,
      mode,
      stopChunk: mode === 'error' ? conversionBudgetErrorChunk(clientProtocol, invocation.requestId) : null,
    },
  };
}

// All successful v3/v6 object conversions must carry the private response
// marker. Invalid native data must fail closed inside the center.
function translatedObject(native: Record<string, unknown>, invocation: Invocation, headers: Headers, status: number): Response | null {
  if (!invocation.returnObject || !invocation.inputSurface) return null;
  const upstreamProtocol = protocolForSurface(invocation.surface);
  const clientProtocol = protocolForSurface(invocation.inputSurface);
  if (!upstreamProtocol || !clientProtocol) return null;
  try {
    const { reply } = replyFromNativeObject(upstreamProtocol, native);
    if (!reply.parts.some((part) => part.type === 'text' && part.text) && !reply.parts.some((part) => part.type === 'tool_call')) {
      return null;
    }
    const converted = replyToObject(reply, clientProtocol) as Record<string, unknown>;
    const outgoing = new Headers(headers);
    outgoing.set('content-type', 'application/json');
    outgoing.set('x-aig-response-format', INFERENCE_TRANSLATED_OBJECT_FORMAT);
    return new Response(JSON.stringify({ kind: INFERENCE_TRANSLATED_OBJECT_FORMAT, response: converted, upstreamUsage: reply.rawUsage ?? null }), {
      status,
      headers: outgoing,
    });
  } catch {
    // A malformed/unsupported native object follows the same Gateway error
    // classification path as v2; never mislabel a raw object as translated.
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

export async function executeNative(request: Request, env: GatewayEnv, invocation: Invocation, options: ExecutionOptions = {}): Promise<Response> {
  const config = loadExecutionConfig(env);
  // Keep serving strictly validated nodes in a degraded configuration, as the
  // former Gateway did. Invalid nodes and missing secrets are already excluded
  // by loadExecutionConfig; an entirely unusable center still fails closed.
  if (!config.ready) return problem(503, 'center_configuration_invalid');
  const node = nativeNode(config.nodes, invocation, env);
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
    return await executeAdmittedNative(request, env, invocation, node, maxRequestBytes, options);
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
  if (invocation.returnObject && clientBody.stream === true) return problem(400, 'center_stream_invalid');
  // v4 is solely for real streaming requests; never synthesize an object
  // protocol response under a private framed-stream ticket.
  if (invocation.returnStream && (clientBody.stream !== true || !invocation.inputSurface || !invocation.displayModel))
    return problem(400, 'center_stream_invalid');
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
  const clientRequest = buildProviderForwardRequest(request);
  if (physicalModel !== invocation.logicalModel) {
    outboundBody = { ...outboundBody, model: physicalModel };
    isMutated = true;
  }
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

  const dispatchedConversionProblem = (code: string): Response => {
    const response = problem(502, code);
    response.headers.set('x-aig-result', EXECUTION_WIRE_RESULT.DISPATCHED);
    response.headers.set('x-aig-upstream-status', String(upstream.status));
    return response;
  };
  const dispatchedDeadlineProblem = (): Response => {
    const response = problem(504, EXECUTION_ERROR_CODE.CENTER_EXECUTION_DEADLINE);
    response.headers.set('x-aig-result', EXECUTION_WIRE_RESULT.DISPATCHED);
    response.headers.set('x-aig-upstream-status', String(upstream.status));
    return response;
  };
  const bufferedResponseDeadlineMs = Math.min(invocation.bufferedResponseDeadlineMs ?? invocation.deadlineMs, invocation.deadlineMs);
  if (invocation.returnStream && upstream.ok && content?.toLowerCase().includes('text/event-stream')) {
    const from = protocolForSurface(invocation.surface);
    const to = invocation.inputSurface ? protocolForSurface(invocation.inputSurface) : null;
    if (!from || !to) return problem(400, 'center_conversion_route_invalid');
    const framed = buildFramedMatrixResponse(upstream.body, from, to, invocation.requestId, streamFramingOptions(invocation, to));
    outgoing.set('content-type', framed.headers.get('content-type') ?? '');
    outgoing.set('x-aig-response-format', framed.headers.get('x-aig-response-format') ?? '');
    return new Response(framed.body, { status: upstream.status, headers: outgoing });
  }
  if (invocation.returnStream && upstream.ok && !content?.toLowerCase().includes('text/event-stream')) {
    // v4/v5: even when Provider ignores stream:true and returns native JSON,
    // its object→IR→client SSE conversion stays inside the private center.
    // Never forward unframed Provider bytes for Gateway to decode.
    const from = protocolForSurface(invocation.surface);
    const to = invocation.inputSurface ? protocolForSurface(invocation.inputSurface) : null;
    if (!from || !to || !invocation.displayModel) return dispatchedConversionProblem('center_conversion_route_invalid');
    let raw: string;
    try {
      raw = await readBufferedReplyText(upstream, bufferedResponseDeadlineMs);
    } catch {
      if (Date.now() >= bufferedResponseDeadlineMs) return dispatchedDeadlineProblem();
      return dispatchedConversionProblem('center_buffered_reply_invalid');
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return dispatchedConversionProblem('center_converted_object_invalid');
      const framed = buildFramedMatrixObjectFallback(parsed as Record<string, unknown>, from, to, invocation.displayModel);
      if (Date.now() >= bufferedResponseDeadlineMs) return dispatchedDeadlineProblem();
      outgoing.set('content-type', framed.headers.get('content-type') ?? '');
      outgoing.set('x-aig-response-format', framed.headers.get('x-aig-response-format') ?? '');
      return new Response(framed.body, { status: upstream.status, headers: outgoing });
    } catch {
      return dispatchedConversionProblem('center_converted_object_invalid');
    }
  }
  if (invocation.returnObject && upstream.ok && content?.toLowerCase().includes('text/event-stream')) {
    // v3 (Provider ignored prefer-nonstream) and v6 both collect physical SSE
    // inside Inference. Gateway receives one tagged object, never raw SSE.
    const from = protocolForSurface(invocation.surface);
    const to = invocation.inputSurface ? protocolForSurface(invocation.inputSurface) : null;
    if (!from || !to) return dispatchedConversionProblem('center_conversion_route_invalid');
    let rawUsage: unknown = null;
    const fallbackLimits = invocation.preferNonstream ? getLimits(env) : null;
    const collectedBudget =
      invocation.streamBudget ??
      (fallbackLimits?.conversionBudget
        ? {
            mode: fallbackLimits.conversionBudgetMode,
            cfg: {
              ...fallbackLimits.conversionBudgetCfg,
              maxOutputUnits: fallbackLimits.conversionNonstreamMaxUnits,
              maxOutputTokens: fallbackLimits.conversionBudgetMaxTokens,
            },
          }
        : undefined);
    try {
      const converted = await collectMatrixObject(upstream.body, from, to, invocation.requestId, request.signal, bufferedResponseDeadlineMs, {
        model: invocation.logicalModel,
        seedInputTokens: from === 'anthropic' ? estimateAnthropicInputTokens(clientBody) : 0,
        onUpstreamUsage: (usage) => {
          rawUsage = usage;
        },
        ...(collectedBudget ? { budget: collectedBudget } : {}),
      });
      if (Date.now() >= bufferedResponseDeadlineMs) return dispatchedDeadlineProblem();
      if (
        !converted.reply.parts.some((part) => part.type === 'text' && part.text) &&
        !converted.reply.parts.some((part) => part.type === 'tool_call')
      ) {
        return dispatchedConversionProblem('center_conversion_empty');
      }
      outgoing.set('content-type', 'application/json');
      outgoing.set('x-aig-response-format', INFERENCE_TRANSLATED_OBJECT_FORMAT);
      return new Response(
        JSON.stringify({
          kind: INFERENCE_TRANSLATED_OBJECT_FORMAT,
          response: converted.object,
          upstreamUsage: converted.reply.rawUsage ?? rawUsage,
        }),
        { status: upstream.status, headers: outgoing },
      );
    } catch (error) {
      if (error instanceof ConversionBudgetStop) return dispatchedConversionProblem(EXECUTION_ERROR_CODE.CENTER_CONVERSION_BUDGET_EXCEEDED);
      if (Date.now() >= bufferedResponseDeadlineMs) return dispatchedDeadlineProblem();
      return dispatchedConversionProblem('center_conversion_invalid');
    }
  }
  if (invocation.returnObject && upstream.ok && !content?.toLowerCase().includes('text/event-stream')) {
    // Translate v3/v6 native JSON inside Inference. Never return unmarked
    // successful objects for Gateway to decode using its legacy Matrix path.
    let raw: string;
    try {
      raw = await readBufferedReplyText(upstream, bufferedResponseDeadlineMs);
    } catch {
      if (Date.now() >= bufferedResponseDeadlineMs) return dispatchedDeadlineProblem();
      const response = problem(502, 'center_buffered_reply_invalid');
      response.headers.set('x-aig-result', EXECUTION_WIRE_RESULT.DISPATCHED);
      response.headers.set('x-aig-upstream-status', String(upstream.status));
      return response;
    }
    try {
      const native: unknown = JSON.parse(raw);
      if (native && typeof native === 'object' && !Array.isArray(native)) {
        const translated = translatedObject(native as Record<string, unknown>, invocation, outgoing, upstream.status);
        if (Date.now() >= bufferedResponseDeadlineMs) return dispatchedDeadlineProblem();
        if (translated) return translated;
      }
    } catch {
      return dispatchedConversionProblem('center_converted_object_invalid');
    }
    return dispatchedConversionProblem('center_converted_object_invalid');
  }
  // Raw body stream ownership transfers to the caller. No buffering, no
  // JSON inspection of model output, and no further provider retry here.
  return new Response(upstream.body, { status: upstream.status, headers: outgoing });
}
