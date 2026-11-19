import { attemptFirstEventTimeoutMs, requestSizeAllowanceMs } from '../../../src/config/timeouts.ts';
import { reportedUsageFromPayload } from '../../../src/observability/reported-usage.ts';
import { classifyClientAbort, classifyFirstEventFailure } from '../../../src/reliability/classify.ts';
import { markProbeFailure, recordTtft } from '../../../src/reliability/node-state.ts';
import { commitTier1RecoveryProbe, recordTier1Ttft } from '../../../src/reliability/tier1-state.ts';
import { combineAbortSignals } from '../../../src/stream/abort-signals.ts';
import { ensureFirstSseEvent, GUARD_ERROR, guardedStreamFailureReason } from '../../../src/stream/guard.ts';
import { relayStreamResponse, trackStreamResponse } from '../../../src/stream/track.ts';
import { isAnthropicNativeRealOutput, isOpenAIChatRealOutput, isResponsesRealOutput } from '../../../src/transport/index.ts';
import type { AttemptOutcome } from '../../../src/types/request.ts';
import { gatewayError } from '../response/errors.ts';
import { finalHeaders, streamInterruptionChunk, upstreamModelOf } from '../response/response-helpers.ts';
import { makeNodeStreamTrack, observeUpstreamAttemptUsage, recordTokens } from './observability.ts';
import { hedgeLoserOutcome, recordOutcome } from './outcome.ts';
import type { SuccessArgs } from './success.ts';

export async function handleStreamingSuccess(s: SuccessArgs): Promise<AttemptOutcome> {
  const { upstream, c, latencyMs, detach } = s;
  const { request, env, requestId, route, node, requestedModel, limits, exposeUpstreamInfo, state, policy } = c;
  const surface = c.surface;
  const extraHeaders = {
    'x-request-id': requestId,
    ...(exposeUpstreamInfo ? { 'x-gateway-node': node.id, 'x-gateway-tier': node.tier } : {}),
  };
  const needsModelRewrite = requestedModel !== upstreamModelOf(node, c.reqDescriptor.model);

  const guardStartMs = Date.now();
  const firstEventSignal = combineAbortSignals(request.signal, c.hedgeAbort?.signal);
  let guarded: Response;
  try {
    const remainingRequestBudgetMs =
      (c.failoverBudgetMs ?? limits.failoverBudgetMs) - (Date.now() - (c.requestStartMs || (s.attemptStartMs as number) || Date.now()));
    const remainingAttemptBudgetMs = (c.attemptDeadlineMs ?? Date.now()) - Date.now();
    const effectiveFirstEventTimeoutMs =
      (policy?.firstEventTimeoutMs ?? limits.firstEventTimeoutMs) + requestSizeAllowanceMs(c.reqDescriptor.bodyChars);
    const firstEventTimeout = attemptFirstEventTimeoutMs(
      effectiveFirstEventTimeoutMs,
      Math.min(remainingRequestBudgetMs, remainingAttemptBudgetMs),
      1,
    );
    const isRealOutput =
      surface === 'messages'
        ? isAnthropicNativeRealOutput
        : surface === 'responses'
          ? isResponsesRealOutput
          : surface === 'chat_completions'
            ? isOpenAIChatRealOutput
            : undefined;
    guarded = await ensureFirstSseEvent(
      upstream,
      firstEventTimeout,
      firstEventSignal.signal,
      isRealOutput,
      (event: unknown) => {
        const usage = reportedUsageFromPayload(event);
        if (usage != null) observeUpstreamAttemptUsage(c, usage);
      },
      limits.streamPassthrough ? { maxPreBytes: limits.streamGuardPrefixBytes } : {},
    );
  } catch (e) {
    firstEventSignal.dispose();
    detach();
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : GUARD_ERROR.EMPTY;
    if (request.signal?.aborted) {
      recordOutcome(state, node, classifyClientAbort(), c, {
        latencyMs: Date.now() - (c.attemptStartMs as number),
        ttftWaitMs: Date.now() - guardStartMs,
        status: upstream.status,
      });
      return { response: gatewayError(request, env, route, 499, 'Client closed the request before the first stream event.', requestId) };
    }
    if (c.hedgeAbort?.signal.aborted) {
      return hedgeLoserOutcome(c, node, 'first_event');
    }
    const classification = classifyFirstEventFailure();
    if (node.tier !== 'tier-1') markProbeFailure(node.id, state.requestedModel);
    recordOutcome(state, node, classification, c, {
      latencyMs: Date.now() - (c.attemptStartMs as number),
      ttftWaitMs: Date.now() - guardStartMs,
      status: upstream.status,
      diagnostic: code,
    });
    return { rotate: true, kind: classification.kind };
  }

  firstEventSignal.dispose();
  detach();
  c.ttftMs = Date.now() - (c.attemptStartMs as number);
  if (node.tier === 'tier-1') {
    recordTier1Ttft(node.id, c.reqDescriptor?.model ?? state.requestedModel, c.ttftMs);
    commitTier1RecoveryProbe(node.id, c.reqDescriptor?.model ?? state.requestedModel);
  } else recordTtft(node.id, c.ttftMs, state.requestedModel);
  const hiddenStreamFailure = () => guardedStreamFailureReason(guarded);
  const headers = finalHeaders(env, request, guarded.headers, extraHeaders);

  if (limits.streamPassthrough && !needsModelRewrite) {
    const relayed = relayStreamResponse(new Response(guarded.body, { status: 200, headers }), {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      protocol: route === 'openai_chat' ? 'openai_chat' : route === 'openai_responses' ? 'openai_responses' : 'anthropic',
      onUsage: (usage: unknown) => recordTokens(c, node, usage),
      ...makeNodeStreamTrack(c, node, latencyMs),
    });
    return { response: relayed };
  }

  if (route === 'openai_chat') {
    const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      protocol: 'openai_chat',
      ...(needsModelRewrite ? { rewriteModel: requestedModel } : {}),
      onUsage: (u: unknown) => recordTokens(c, node, u),
      interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
      upstreamFailureReason: hiddenStreamFailure,
      ...makeNodeStreamTrack(c, node, latencyMs),
    });
    return { response: tracked };
  }

  if (route === 'openai_responses') {
    const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      protocol: 'openai_responses',
      ...(needsModelRewrite ? { rewriteModel: requestedModel, rewriteModelAt: 'response.model' } : {}),
      onUsage: (u: unknown) => recordTokens(c, node, u),
      interruptionChunk: (reason: string | null, details?: { nextSequenceNumber?: number }) =>
        streamInterruptionChunk(route, requestId, reason, details),
      upstreamFailureReason: hiddenStreamFailure,
      ...makeNodeStreamTrack(c, node, latencyMs),
    });
    return { response: tracked };
  }

  const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
    idleTimeoutMs: limits.streamIdleTimeoutMs,
    protocol: 'anthropic',
    ...(needsModelRewrite ? { rewriteModel: requestedModel, rewriteModelAt: 'message.model' } : {}),
    onUsage: (u: unknown) => recordTokens(c, node, u),
    interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
    upstreamFailureReason: hiddenStreamFailure,
    ...makeNodeStreamTrack(c, node, latencyMs),
  });
  return { response: new Response(tracked.body, { status: 200, headers }) };
}
