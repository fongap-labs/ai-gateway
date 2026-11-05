// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// One private inference attempt using the same gateway-owned scheduler,
// accounting, retry budget, and response finalizers as direct dispatch.
// Once the binding exists there is NO automatic direct-provider fallback.

import { attemptBudgetWindowMs, attemptHeadersTimeoutMs, requestSizeAllowanceMs } from '../../config/timeouts.ts';
import { invokeInferenceNode } from '../../inference/inference-client-request.ts';
import { reportedUsageFromJsonText } from '../../observability/reported-usage.ts';
import { safeReadErrorBody } from '../../protocol/http.ts';
import { isOpenAIStreamingResponse } from '../../protocol/openai.ts';
import { classifyClientAbort, classifyNetworkError, classifyUpstreamStatus, KIND } from '../../reliability/classify.ts';
import type { QuotaSignal } from '../../reliability/quota-signal.ts';
import { recordTier1QuotaReport } from '../../reliability/tier1-state.ts';
import type { AttemptContext, AttemptOutcome } from '../../types/request.ts';
import { buildClientErrorResponse, gatewayError } from '../errors.ts';
import { recordUndeliveredUpstreamAttempt } from './observability.ts';
import { hedgeLoserOutcome, recordOutcome, rotateWithNeutralEnd } from './outcome.ts';
import { handleSuccess } from './success.ts';

const INTERNAL_TARGET = 'https://inference.internal/internal/execute';
const CENTER_HEADER_LIMIT = 512;

function stopForCenter(c: AttemptContext, status: number, code: string): AttemptOutcome {
  rotateWithNeutralEnd(c.state, c.node, KIND.AUTH, c, true);
  return {
    budgetCharged: false,
    response: gatewayError(c.request, c.env, c.route, status, 'Private inference center is unavailable.', c.requestId, undefined, undefined, code),
  };
}

function quotaFromCenter(headers: Headers): QuotaSignal | null {
  const encoded = headers.get('x-aig-quota-signal');
  if (!encoded || encoded.length > CENTER_HEADER_LIMIT) return null;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const fields = ['remainingRequests', 'remainingTokens', 'limitRequests', 'limitTokens', 'resetAtMs'];
    const signal: QuotaSignal = { source: 'inference-center' };
    for (const field of fields) {
      const value = record[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
      Object.assign(signal, { [field]: value });
    }
    return signal.remainingRequests === undefined && signal.remainingTokens === undefined ? null : signal;
  } catch {
    return null;
  }
}

export async function dispatchInferenceAttempt(c: AttemptContext, sourceBody: Record<string, unknown>): Promise<AttemptOutcome> {
  const { request, env, node, state, reqDescriptor, policy, limits, requestedModel, route } = c;
  const effectiveModel = reqDescriptor.model;
  const body: Record<string, unknown> = { ...sourceBody, model: effectiveModel };
  if (c.fakeStream && c.surface === 'chat_completions') body.stream = true;
  // Avoid a second copy for normal native requests with no alias or stream mutation.
  const reuseRaw = !c.conversionContext && !c.fakeStream && Boolean(c.rawBody?.text) && c.bodyJson.model === effectiveModel;
  const outboundBody = reuseRaw && c.rawBody ? c.rawBody.text : JSON.stringify(body);
  if (c.rawBody && c.rawBody.text.length > 50_000) c.rawBody.text = '';

  const hasBufferedResponse = !c.conversionContext && !c.clientWantsStream && !c.fakeStream;
  const configuredHeadersMs = (policy.headersTimeoutMs ?? limits.headersTimeoutMs) + requestSizeAllowanceMs(reqDescriptor.bodyChars);
  const remainingBudgetMs = c.failoverBudgetMs - (Date.now() - c.requestStartMs);
  const attemptBudgetMs =
    c.hedgedAttempt && c.attemptDeadlineMs
      ? c.attemptDeadlineMs - Date.now()
      : attemptBudgetWindowMs(remainingBudgetMs, c.remainingDispatchableAttempts);
  if (remainingBudgetMs <= 0 || attemptBudgetMs <= 0) {
    return stopForCenter(c, 504, 'gateway_inference_deadline_expired');
  }
  const windowMs = c.attemptCapMs && !hasBufferedResponse ? Math.min(attemptBudgetMs, c.attemptCapMs) : attemptBudgetMs;
  c.attemptDeadlineMs = Math.min(Date.now() + windowMs, c.requestStartMs + c.failoverBudgetMs, Date.now() + 540_000);
  const headersTimeout = attemptHeadersTimeoutMs(
    hasBufferedResponse || c.takeRemainingWindow ? Math.max(configuredHeadersMs, windowMs) : configuredHeadersMs,
    Math.max(1, c.attemptDeadlineMs - Date.now()),
    1,
  );

  const controller = new AbortController();
  let hasTimedOut = false;
  const timer = setTimeout(() => {
    hasTimedOut = true;
    controller.abort();
  }, headersTimeout);
  const onClientAbort = () => controller.abort();
  const onHedgeAbort = () => controller.abort();
  if (request.signal.aborted) onClientAbort();
  else request.signal.addEventListener('abort', onClientAbort, { once: true });
  if (c.hedgeAbort?.signal.aborted) onHedgeAbort();
  else c.hedgeAbort?.signal.addEventListener('abort', onHedgeAbort, { once: true });
  const detach = () => {
    request.signal.removeEventListener('abort', onClientAbort);
    c.hedgeAbort?.signal.removeEventListener('abort', onHedgeAbort);
  };

  const dispatchStartMs = Date.now();
  let upstream: Response;
  try {
    upstream = await invokeInferenceNode(env, {
      request,
      requestId: c.requestId,
      node,
      logicalModel: effectiveModel,
      surface: c.surface ?? reqDescriptor.surface,
      deadlineMs: c.attemptDeadlineMs,
      body: outboundBody,
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    detach();
    if (c.hedgeAbort?.signal.aborted) return hedgeLoserOutcome(c, node, 'center_headers');
    if (request.signal.aborted) {
      recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: Date.now() - dispatchStartMs });
      return { response: gatewayError(request, env, route, 499, 'Client closed the request.', c.requestId) };
    }
    // An RPC failure is not evidence that the selected PROVIDER is unhealthy.
    // Never retry by bypassing the private center: it may already have executed.
    return stopForCenter(c, hasTimedOut ? 504 : 503, 'gateway_inference_center_unavailable');
  }
  clearTimeout(timer);
  c.headersMs = Date.now() - dispatchStartMs;
  c.upstreamStatus = upstream.status;

  const executionResult = upstream.headers.get('x-aig-result');
  if (executionResult === 'attempted' && upstream.headers.get('x-aig-error-kind') === 'center_upstream_network') {
    detach();
    const classified = classifyNetworkError(false);
    recordOutcome(state, node, classified, c, { latencyMs: c.headersMs });
    return { rotate: true, kind: classified.kind };
  }
  if (executionResult !== 'dispatched') {
    detach();
    return stopForCenter(c, upstream.status === 413 ? 413 : 503, 'gateway_inference_center_rejected');
  }
  if (node.tier === 'tier-1') {
    const signal = quotaFromCenter(upstream.headers);
    if (signal) recordTier1QuotaReport(node.id, signal);
  }

  if (!upstream.ok) {
    detach();
    const errorText = await safeReadErrorBody(upstream, 4096, c.attemptDeadlineMs);
    const classified = classifyUpstreamStatus(upstream.status, upstream.headers, env, undefined, errorText);
    recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromJsonText(errorText));
    recordOutcome(state, node, classified, c, { latencyMs: c.headersMs, status: upstream.status, diagnostic: errorText });
    if (classified.action === 'stop') {
      return {
        response: buildClientErrorResponse(request, env, route, c.requestId, requestedModel, upstream.status, errorText, state, c.exposeUpstreamInfo),
      };
    }
    return { rotate: true, kind: classified.kind };
  }

  const physicalModel = node.models[effectiveModel] || effectiveModel;
  const successNode = effectiveModel === requestedModel ? node : { ...node, models: { ...node.models, [requestedModel]: physicalModel } };
  const successContext = successNode === node ? c : { ...c, node: successNode };
  return handleSuccess({
    upstream,
    c: successContext,
    targetUrl: INTERNAL_TARGET,
    latencyMs: c.headersMs,
    detach,
    upstreamWasStreaming: isOpenAIStreamingResponse(upstream),
  });
}
