import { readEnv } from '../../../packages/config-core/env.ts';
import {
  EXECUTION_ERROR_CODE,
  EXECUTION_WIRE_RESULT,
  type ExecutionInputSurface,
  INFERENCE_TRANSLATED_OBJECT_FORMAT,
  parseExecutionResponse,
} from '../../../packages/contracts/execution.ts';
import { INFERENCE_FRAMED_STREAM_CONTENT_TYPE, INFERENCE_FRAMED_STREAM_FORMAT } from '../../../packages/contracts/inference-stream-frames.ts';
import { requestReasoningPreference } from '../../../packages/contracts/reasoning-preference.ts';
import {
  attemptBudgetWindowMs,
  attemptHeadersTimeoutMs,
  centerResponseDeadlineMs,
  requestSizeAllowanceMs,
  viableFailoverWindowMs,
} from '../../../src/config/timeouts.ts';
import { reportedUsageFromJsonText } from '../../../src/observability/reported-usage.ts';
import { safeReadErrorBody } from '../../../src/protocol/http.ts';
import { isOpenAIStreamingResponse } from '../../../src/protocol/openai.ts';
import {
  classifyClientAbort,
  classifyConversionBudget,
  classifyNetworkError,
  classifyUpstreamStatus,
  KIND,
} from '../../../src/reliability/classify.ts';
import { recordTier1QuotaReport } from '../../../src/reliability/tier1-state.ts';
import type { AttemptContext, AttemptOutcome } from '../../../src/types/request.ts';
import { quotaFromCenter } from '../reliability/center-quota.ts';
import { buildClientErrorResponse, gatewayError } from '../response/errors.ts';
import { type InferenceCenter, InferenceCenterUnavailable, invokeInferenceNode } from '../transport/inference-client-request.ts';
import { invokePerceptionNode, PerceptionCenterUnavailable } from '../transport/perception-client-request.ts';
import { requestBodyForAttempt } from '../transport/request-body-cache.ts';
import { recordUndeliveredUpstreamAttempt } from './observability.ts';
import { hedgeLoserOutcome, recordOutcome, rotateWithNeutralEnd, stopAfterDispatchedCenterFault } from './outcome.ts';
import { handleSuccess } from './success.ts';

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

function stopForCenter(c: AttemptContext, status: number, code: string, center: InferenceCenter = 'inference'): AttemptOutcome {
  rotateWithNeutralEnd(c.state, c.node, KIND.AUTH, c, true);
  const centerName = center === 'perception' ? 'Private perception center' : 'Private inference center';
  return {
    budgetCharged: false,
    response: gatewayError(
      c.request,
      c.env,
      c.route,
      status,
      status === 504
        ? `${centerName} did not finish before the execution deadline; upstream outcome is unknown.`
        : status === 502
          ? `${centerName} transport failed; upstream execution may already have started.`
          : `${centerName} is unavailable.`,
      c.requestId,
      undefined,
      undefined,
      center === 'perception' ? code.replace('inference', 'perception') : code,
    ),
  };
}

function stopForDispatchedCenterContract(c: AttemptContext, code: string, center: InferenceCenter): AttemptOutcome {
  const name = center === 'perception' ? 'Private perception center' : 'Private inference center';
  return stopAfterDispatchedCenterFault(
    c,
    gatewayError(
      c.request,
      c.env,
      c.route,
      502,
      `${name} returned an invalid response contract after upstream dispatch.`,
      c.requestId,
      undefined,
      undefined,
      center === 'perception' ? code.replace('inference', 'perception') : code,
    ),
  );
}

export async function dispatchInferenceAttempt(
  c: AttemptContext,
  sourceBody: Record<string, unknown>,
  center: InferenceCenter = 'inference',
): Promise<AttemptOutcome> {
  const invokeNode = center === 'perception' ? invokePerceptionNode : invokeInferenceNode;
  const { request, env, node, state, reqDescriptor, policy, limits, requestedModel, route } = c;
  const effectiveModel = reqDescriptor.model;
  const inputSurface = c.conversionContext ? inputSurfaceForClientRoute(c.conversionContext.clientRoute) : undefined;
  if (c.conversionContext && !inputSurface) return stopForCenter(c, 502, 'gateway_inference_conversion_route_invalid', center);
  const outboundBody = requestBodyForAttempt(
    c.state,
    c.conversionContext ? c.bodyJson : sourceBody,
    c.rawBody?.text,
    effectiveModel,
    !c.conversionContext && c.fakeStream && c.surface === 'chat_completions',
  );

  const returnStream = Boolean(c.conversionContext && c.clientWantsStream && !c.fakeStream && c.bodyJson.stream === true);
  const returnTranslatedObject = Boolean(c.conversionContext && !c.clientWantsStream);
  const returnCollectedObject = Boolean(returnTranslatedObject && !c.conversionContext?.isNonstreamPreferred);
  const streamBudget =
    (returnStream || returnCollectedObject) && limits.conversionBudget
      ? {
          mode: limits.conversionBudgetMode,
          cfg: {
            ...limits.conversionBudgetCfg,
            maxOutputUnits: returnCollectedObject ? limits.conversionNonstreamMaxUnits : limits.conversionBudgetCfg.maxOutputUnits,
            maxOutputTokens: limits.conversionBudgetMaxTokens,
          },
        }
      : undefined;
  const hasBufferedResponse = (!c.conversionContext && !c.clientWantsStream && !c.fakeStream) || returnTranslatedObject;
  const sizeAllowanceMs = requestSizeAllowanceMs(reqDescriptor.bodyChars);
  const configuredHeadersMs = (policy.headersTimeoutMs ?? limits.headersTimeoutMs) + sizeAllowanceMs;
  const explicitHeaderTimeout = policy.headersTimeoutMs != null || readEnv(env, 'AIG_UPSTREAM_HEADER_TIMEOUT_MS') !== undefined;
  const streamingHeadersMs =
    c.clientWantsStream && !c.fakeStream && !explicitHeaderTimeout
      ? Math.max(configuredHeadersMs, (policy.firstEventTimeoutMs ?? limits.firstEventTimeoutMs) + sizeAllowanceMs)
      : configuredHeadersMs;
  const remainingBudgetMs = c.failoverBudgetMs - (Date.now() - c.requestStartMs);
  const baseAttemptBudgetMs = attemptBudgetWindowMs(remainingBudgetMs, c.remainingDispatchableAttempts);
  const viableReserveMs = viableFailoverWindowMs(reqDescriptor.bodyChars);
  const attemptBudgetMs =
    c.hedgedAttempt && c.attemptDeadlineMs
      ? c.attemptDeadlineMs - Date.now()
      : viableReserveMs > 0
        ? attemptBudgetWindowMs(remainingBudgetMs, c.remainingDispatchableAttempts, viableReserveMs)
        : baseAttemptBudgetMs;
  if (remainingBudgetMs <= 0 || attemptBudgetMs <= 0) {
    return stopForCenter(c, 504, 'gateway_inference_deadline_expired', center);
  }
  const windowMs = c.attemptCapMs ? Math.min(attemptBudgetMs, c.attemptCapMs) : attemptBudgetMs;
  c.attemptDeadlineMs = Math.min(Date.now() + windowMs, c.requestStartMs + c.failoverBudgetMs, Date.now() + 540_000);
  const headersTimeout = attemptHeadersTimeoutMs(
    hasBufferedResponse || c.takeRemainingWindow ? Math.max(streamingHeadersMs, windowMs) : streamingHeadersMs,
    Math.max(1, c.attemptDeadlineMs - Date.now()),
    1,
  );
  const upstreamHeadersTimeoutMs = attemptHeadersTimeoutMs(
    hasBufferedResponse || c.takeRemainingWindow ? Math.max(streamingHeadersMs, windowMs) : streamingHeadersMs,
    Math.max(1, c.attemptDeadlineMs - Date.now()),
    1,
  );
  const upstreamHeadersDeadlineMs = centerResponseDeadlineMs(Date.now() + upstreamHeadersTimeoutMs);
  const bufferedResponseDeadlineMs = returnTranslatedObject ? centerResponseDeadlineMs(c.attemptDeadlineMs) : undefined;

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
    upstream = await invokeNode(env, {
      request,
      requestId: c.requestId,
      traceparent: c.traceparent,
      node,
      logicalModel: effectiveModel,
      surface: c.surface ?? reqDescriptor.surface,
      inputSurface: inputSurface ?? undefined,
      preferNonstream: c.conversionContext?.isNonstreamPreferred ? true : undefined,
      returnObject: c.conversionContext && !c.clientWantsStream ? true : undefined,
      returnStream: returnStream ? true : undefined,
      streamBudget,
      displayModel: returnStream ? requestedModel : undefined,
      reasoningPreference: requestReasoningPreference(c.bodyJson),
      deadlineMs: c.attemptDeadlineMs,
      upstreamHeadersDeadlineMs,
      bufferedResponseDeadlineMs,
      body: outboundBody,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    detach();
    c.headersMs = Math.max(0, Date.now() - dispatchStartMs);
    if (c.hedgeAbort?.signal.aborted) return hedgeLoserOutcome(c, node, 'center_headers');
    if (request.signal.aborted) {
      recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: Date.now() - dispatchStartMs });
      return { response: gatewayError(request, env, route, 499, 'Client closed the request.', c.requestId) };
    }
    if (error instanceof InferenceCenterUnavailable || error instanceof PerceptionCenterUnavailable) {
      return stopForCenter(c, 503, EXECUTION_ERROR_CODE.GATEWAY_INFERENCE_CENTER_UNAVAILABLE, center);
    }
    c.upstreamStatus = hasTimedOut ? 504 : 502;
    c.logger?.error?.(
      `center-transport request=${c.requestId} center=${center} stage=${hasTimedOut ? 'gateway_headers_deadline' : 'binding_rejection'}` +
        ` elapsed_ms=${c.headersMs} status=${c.upstreamStatus} outcome=unknown`,
    );
    return stopAfterDispatchedCenterFault(
      c,
      gatewayError(
        request,
        env,
        route,
        hasTimedOut ? 504 : 502,
        'Private execution transport failed; upstream outcome is unknown.',
        c.requestId,
        undefined,
        undefined,
        'gateway_center_outcome_unknown',
      ),
    );
  }
  clearTimeout(timer);
  c.headersMs = Date.now() - dispatchStartMs;
  c.upstreamStatus = upstream.status;

  const execution = parseExecutionResponse(upstream);
  if (c.hedgeAbort?.signal.aborted) {
    detach();
    return hedgeLoserOutcome(c, node, 'center_headers');
  }
  if (request.signal.aborted) {
    detach();
    if (execution.result === EXECUTION_WIRE_RESULT.DISPATCHED) recordUndeliveredUpstreamAttempt(c, node);
    recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: c.headersMs });
    return { response: gatewayError(request, env, route, 499, 'Client closed the request.', c.requestId) };
  }
  if (execution.result === EXECUTION_WIRE_RESULT.ATTEMPTED) {
    detach();
    const classified = classifyNetworkError(execution.phase === 'upstream-headers');
    recordOutcome(state, node, classified, c, { latencyMs: c.headersMs });
    return { rotate: true, kind: classified.kind };
  }
  if (execution.verifiedPreDispatchRotation) {
    detach();
    return rotateWithNeutralEnd(state, node, KIND.AUTH, c, true);
  }
  if (
    execution.result === EXECUTION_WIRE_RESULT.DISPATCHED &&
    upstream.status === 504 &&
    execution.code === EXECUTION_ERROR_CODE.CENTER_EXECUTION_DEADLINE
  ) {
    detach();
    const classified = classifyNetworkError(true);
    recordOutcome(state, node, classified, c, { latencyMs: c.headersMs, status: upstream.status });
    return { rotate: true, kind: classified.kind };
  }
  if (execution.result !== EXECUTION_WIRE_RESULT.DISPATCHED) {
    detach();
    const preDispatchCode = upstream.headers.get('x-aig-error-kind');
    if (
      execution.result === EXECUTION_WIRE_RESULT.NOT_DISPATCHED &&
      (upstream.status === 400 || upstream.status === 422) &&
      (preDispatchCode === 'center_conversion_invalid' ||
        preDispatchCode === 'center_conversion_route_invalid' ||
        preDispatchCode === 'center_conversion_semantic_loss')
    ) {
      const semanticLoss = preDispatchCode === 'center_conversion_semantic_loss';
      return {
        budgetCharged: false,
        response: gatewayError(
          request,
          env,
          route,
          upstream.status,
          semanticLoss ? 'Cross-protocol request would lose required tool or reasoning semantics.' : 'Cross-protocol request is not valid.',
          c.requestId,
          undefined,
          undefined,
          semanticLoss ? 'gateway_protocol_semantic_loss' : 'gateway_protocol_invalid_request',
          false,
        ),
      };
    }
    if (upstream.status === 503 && execution.code === EXECUTION_ERROR_CODE.CENTER_BODY_BUDGET_EXHAUSTED) {
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
    return stopForCenter(c, upstream.status === 413 ? 413 : 503, 'gateway_inference_center_rejected', center);
  }
  if (
    returnStream &&
    upstream.ok &&
    (upstream.headers.get('x-aig-response-format') !== INFERENCE_FRAMED_STREAM_FORMAT ||
      !upstream.headers.get('content-type')?.toLowerCase().includes(INFERENCE_FRAMED_STREAM_CONTENT_TYPE))
  ) {
    detach();
    return stopForDispatchedCenterContract(c, 'gateway_inference_stream_format_invalid', center);
  }
  if (node.tier === 'tier-1') {
    const signal = quotaFromCenter(upstream.headers);
    if (signal) recordTier1QuotaReport(node.id, signal);
  }

  if (returnTranslatedObject && execution.code === EXECUTION_ERROR_CODE.CENTER_CONVERSION_BUDGET_EXCEEDED && upstream.status === 502) {
    detach();
    recordUndeliveredUpstreamAttempt(c, node);
    recordOutcome(state, node, classifyConversionBudget(), c, { latencyMs: c.headersMs, status: upstream.status });
    return {
      response: gatewayError(
        request,
        env,
        route,
        502,
        'The translated reply exceeds the gateway conversion output budget. Retry with a smaller request.',
        c.requestId,
        undefined,
        undefined,
        'conversion_budget_exceeded',
      ),
    };
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

  if (
    returnTranslatedObject &&
    (upstream.headers.get('x-aig-response-format') !== INFERENCE_TRANSLATED_OBJECT_FORMAT ||
      !upstream.headers.get('content-type')?.toLowerCase().includes('application/json'))
  ) {
    detach();
    return stopForDispatchedCenterContract(c, 'gateway_inference_object_format_invalid', center);
  }

  const physicalModel = node.models[effectiveModel] || effectiveModel;
  const successNode = effectiveModel === requestedModel ? node : { ...node, models: { ...node.models, [requestedModel]: physicalModel } };
  const successContext = successNode === node ? c : { ...c, node: successNode };
  return handleSuccess({
    upstream,
    centerFramedStreamExpected: returnStream,
    c: successContext,
    targetUrl: `https://${center}.internal/internal/execute`,
    latencyMs: c.headersMs,
    detach,
    upstreamWasStreaming: isOpenAIStreamingResponse(upstream),
  });
}
