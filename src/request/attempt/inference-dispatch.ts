// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// One private inference attempt using the same gateway-owned scheduler,
// accounting, retry budget, and response finalizers as direct dispatch.
// Once the binding exists there is NO automatic direct-provider fallback.

import type { ExecutionInputSurface } from '../../../packages/contracts/execution.ts';
import { INFERENCE_FRAMED_STREAM_FORMAT } from '../../../packages/contracts/inference-stream-frames.ts';
import { attemptBudgetWindowMs, attemptHeadersTimeoutMs, QUOTA_RETRY_AFTER_MAX_MS, requestSizeAllowanceMs } from '../../config/timeouts.ts';
import { invokeInferenceNode } from '../../../apps/gateway/transport/inference-client-request.ts';
import { reportedUsageFromJsonText } from '../../observability/reported-usage.ts';
import { safeReadErrorBody } from '../../protocol/http.ts';
import { isOpenAIStreamingResponse } from '../../protocol/openai.ts';
import { quotaFromCenter } from '../../reliability/center-quota.ts';
import { classifyClientAbort, classifyNetworkError, classifyUpstreamStatus, KIND } from '../../reliability/classify.ts';
import { recordTier1QuotaReport } from '../../reliability/tier1-state.ts';
import type { AttemptContext, AttemptOutcome } from '../../types/request.ts';
import { buildClientErrorResponse, gatewayError } from '../errors.ts';
import { recordUndeliveredUpstreamAttempt } from './observability.ts';
import { hedgeLoserOutcome, recordOutcome, rotateWithNeutralEnd } from './outcome.ts';
import { handleSuccess } from './success.ts';

const INTERNAL_TARGET = 'https://inference.internal/internal/execute';

function inputSurfaceForClientRoute(route: string): ExecutionInputSurface | null {
  switch (route) {
    case 'openai_chat':
      return 'chat_completions';
    case 'openai_responses':
      return 'responses';
    case 'anthropic_messages':
      return 'messages';
    default:
      return null;
  }
}

function stopForCenter(c: AttemptContext, status: number, code: string): AttemptOutcome {
  rotateWithNeutralEnd(c.state, c.node, KIND.AUTH, c, true);
  return {
    budgetCharged: false,
    response: gatewayError(c.request, c.env, c.route, status, 'Private inference center is unavailable.', c.requestId, undefined, undefined, code),
  };
}

export async function dispatchInferenceAttempt(c: AttemptContext, sourceBody: Record<string, unknown>): Promise<AttemptOutcome> {
  const { request, env, node, state, reqDescriptor, policy, limits, requestedModel, route } = c;
  const effectiveModel = reqDescriptor.model;
  // The center executes conversion from the ORIGINAL protocol shape.
  // Gateway's converted body remains an admission dry-run, not the wire body.
  const inputSurface = c.conversionContext ? inputSurfaceForClientRoute(c.conversionContext.clientRoute) : undefined;
  if (c.conversionContext && !inputSurface) return stopForCenter(c, 502, 'gateway_inference_conversion_route_invalid');
  const body: Record<string, unknown> = { ...(c.conversionContext ? c.bodyJson : sourceBody), model: effectiveModel };
  if (!c.conversionContext && c.fakeStream && c.surface === 'chat_completions') body.stream = true;
  // Avoid a second copy for normal native requests with no alias or stream mutation.
  const reuseRaw = !c.conversionContext && !c.fakeStream && Boolean(c.rawBody?.text) && c.bodyJson.model === effectiveModel;
  const outboundBody = reuseRaw && c.rawBody ? c.rawBody.text : JSON.stringify(body);
  if (c.rawBody && c.rawBody.text.length > 50_000) c.rawBody.text = '';

  // v4 handles ordinary streams; authenticated v5 carries bounded budgets
  // so Inference executes the same IR budget before producing public SSE.
  const returnStream = Boolean(c.conversionContext && c.clientWantsStream && !c.fakeStream && c.bodyJson.stream === true);
  const streamBudget =
    returnStream && limits.conversionBudget
      ? {
          mode: limits.conversionBudgetMode,
          cfg: { ...limits.conversionBudgetCfg, maxOutputTokens: limits.conversionBudgetMaxTokens },
        }
      : undefined;
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
      inputSurface: inputSurface ?? undefined,
      preferNonstream: c.conversionContext?.isNonstreamPreferred ? true : undefined,
      returnObject: c.conversionContext?.isNonstreamPreferred && !c.clientWantsStream && !c.fakeStream ? true : undefined,
      returnStream: returnStream ? true : undefined,
      streamBudget,
      displayModel: returnStream ? requestedModel : undefined,
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
  // A private center can resolve with a 499 after the caller aborts, rather
  // than rejecting its Service Binding promise. Client cancellation must
  // retain the same neutral 499 behavior in both completion paths; treating
  // an unmarked center response as an outage would incorrectly return 503.
  if (c.hedgeAbort?.signal.aborted) {
    detach();
    return hedgeLoserOutcome(c, node, 'center_headers');
  }
  if (request.signal.aborted) {
    detach();
    if (executionResult === 'dispatched') recordUndeliveredUpstreamAttempt(c, node);
    recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: c.headersMs });
    return { response: gatewayError(request, env, route, 499, 'Client closed the request.', c.requestId) };
  }
  if (executionResult === 'attempted' && upstream.headers.get('x-aig-error-kind') === 'center_upstream_network') {
    detach();
    const classified = classifyNetworkError(false);
    recordOutcome(state, node, classified, c, { latencyMs: c.headersMs });
    return { rotate: true, kind: classified.kind };
  }
  // OAuth credential/adapter failures happen before a physical Provider attempt.
  // Preserve legacy neutral rotation while keeping every other center error fail-closed.
  if (executionResult === 'skipped' && node.auth === 'oauth') {
    const centerErrorKind = upstream.headers.get('x-aig-error-kind');
    const isSubscriptionUnavailable =
      upstream.status === 503 && (centerErrorKind === 'center_subscription_unavailable' || centerErrorKind === 'center_subscription_unsupported');
    const isSubscriptionRejected = upstream.status === 502 && centerErrorKind === 'center_subscription_rejected';
    if (isSubscriptionUnavailable || isSubscriptionRejected) {
      detach();
      return rotateWithNeutralEnd(state, node, KIND.AUTH, c, true);
    }
  }
  if (executionResult !== 'dispatched') {
    detach();
    // A center-isolate memory refusal is request-local, not evidence of a bad
    // Provider or an unavailable center. Preserve the Gateway's retryable
    // body-budget 503 and never charge an upstream execution.
    if (upstream.status === 503 && upstream.headers.get('x-aig-error-kind') === 'center_body_budget_exhausted') {
      rotateWithNeutralEnd(state, node, KIND.AUTH, c, true);
      return {
        budgetCharged: false,
        response: gatewayError(
          request,
          env,
          route,
          503,
          'Gateway is busy with other large requests; retry shortly.',
          c.requestId,
          undefined,
          { 'retry-after': '1' },
          'gateway_body_budget_exhausted',
          true,
        ),
      };
    }
    return stopForCenter(c, upstream.status === 413 ? 413 : 503, 'gateway_inference_center_rejected');
  }
  if (
    returnStream &&
    upstream.ok &&
    (isOpenAIStreamingResponse(upstream) ||
      (upstream.headers.has('x-aig-response-format') && upstream.headers.get('x-aig-response-format') !== INFERENCE_FRAMED_STREAM_FORMAT))
  ) {
    // A v4 center MUST NOT return unframed SSE. Reject before any client
    // response byte; no fallback to the direct Provider path.
    detach();
    recordUndeliveredUpstreamAttempt(c, node);
    return stopForCenter(c, 502, 'gateway_inference_stream_format_invalid');
  }
  if (node.tier === 'tier-1') {
    const signal = quotaFromCenter(upstream.headers);
    if (signal) recordTier1QuotaReport(node.id, signal);
  }

  if (!upstream.ok) {
    detach();
    const errorText = await safeReadErrorBody(upstream, 4096, c.attemptDeadlineMs);
    let classified = classifyUpstreamStatus(upstream.status, upstream.headers, env, undefined, errorText);
    // The private center alone decodes subscription-specific error windows.
    // Accept only a bounded neutral duration from the authenticated center;
    // keep physical Provider adapter code and raw headers out of Gateway.
    const resetHeader = upstream.headers.get('x-aig-subscription-quota-reset-ms');
    const resetMs = resetHeader && /^[1-9]\d*$/.test(resetHeader) ? Number(resetHeader) : 0;
    if (
      node.auth === 'oauth' &&
      classified.kind === KIND.RATE_LIMIT &&
      Number.isSafeInteger(resetMs) &&
      resetMs > 0 &&
      resetMs <= QUOTA_RETRY_AFTER_MAX_MS
    ) {
      classified = { ...classified, cooldownMs: Math.max(classified.cooldownMs, resetMs) };
      if (node.tier === 'tier-1') {
        recordTier1QuotaReport(node.id, { remainingRequests: 0, resetAtMs: Date.now() + resetMs, source: 'private-subscription-window' });
      }
    }
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
    centerFramedStreamExpected: returnStream,
    c: successContext,
    targetUrl: INTERNAL_TARGET,
    latencyMs: c.headersMs,
    detach,
    upstreamWasStreaming: isOpenAIStreamingResponse(upstream),
  });
}
