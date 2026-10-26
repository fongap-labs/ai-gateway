// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { attemptFirstEventTimeoutMs, requestSizeAllowanceMs } from '../../config/timeouts.ts';
import { reportedUsageFromPayload } from '../../observability/reported-usage.ts';
import { classifyClientAbort, classifyFirstEventFailure } from '../../reliability/classify.ts';
import { markProbeFailure, recordTtft } from '../../reliability/node-state.ts';
import { commitTier1RecoveryProbe, recordTier1Ttft } from '../../reliability/tier1-state.ts';
import { ensureFirstSseEvent, GUARD_ERROR, guardedStreamFailureReason } from '../../stream/guard.ts';
import { trackStreamResponse } from '../../stream/track.ts';
import { isAnthropicNativeRealOutput, isOpenAIChatRealOutput, isResponsesRealOutput } from '../../transport/index.ts';
import type { AttemptOutcome } from '../../types/request.ts';
import { gatewayError } from '../errors.ts';
import { finalHeaders, streamInterruptionChunk, upstreamModelOf } from '../response-helpers.ts';
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
  const needsModelRewrite = requestedModel !== upstreamModelOf(node, requestedModel);

  // Run the first-event guard BEFORE returning anything to the client. Parsed
  // lifecycle events are also offered to the usage observer before commit, so
  // a provider-reported usage object is not lost merely because the stream
  // later fails before real output.
  const guardStartMs = Date.now();
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
    // Native-only surface: every cross-protocol request is matrix-owned and
    // reaches handleMatrixSuccess instead of this module.
    const isRealOutput =
      surface === 'messages'
        ? isAnthropicNativeRealOutput
        : surface === 'responses'
          ? isResponsesRealOutput
          : surface === 'chat_completions'
            ? isOpenAIChatRealOutput
            : undefined;
    guarded = await ensureFirstSseEvent(upstream, firstEventTimeout, request.signal, isRealOutput, (event: unknown) => {
      const usage = reportedUsageFromPayload(event);
      if (usage != null) observeUpstreamAttemptUsage(c, usage);
    });
  } catch (e) {
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
      // A peer committed while this attempt was waiting for real output.
      // Reliability stays neutral, but the physical dispatch still belongs
      // in upstream accounting (including any usage seen in lifecycle events).
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

  detach();
  c.ttftMs = Date.now() - (c.attemptStartMs as number);
  if (node.tier === 'tier-1') {
    recordTier1Ttft(node.id, state.requestedModel, c.ttftMs);
    // The first SSE event is the v2 recovery-probe evidence for a stream: a
    // key past its rate-limit cooldown that answers here is healthy, and the
    // single-flight window opens immediately (no-op under the legacy gate).
    commitTier1RecoveryProbe(node.id, state.requestedModel);
  } else recordTtft(node.id, c.ttftMs, state.requestedModel);
  const hiddenStreamFailure = () => guardedStreamFailureReason(guarded);
  const headers = finalHeaders(env, request, guarded.headers, extraHeaders);

  if (route === 'openai_chat') {
    const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      completionMarker: /(?:data:\s*\[DONE\]|"finish_reason"\s*:\s*"(?:stop|length|tool_calls|content_filter|function_call)")/,
      closeMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
      completionGraceMs: 500,
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
      completionMarker: /event:\s*response\.(?:completed|incomplete)\b/,
      failureMarker: /event:\s*response\.failed\b/,
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
    completionMarker: /event:\s*message_stop\b/,
    ...(needsModelRewrite ? { rewriteModel: requestedModel, rewriteModelAt: 'message.model' } : {}),
    onUsage: (u: unknown) => recordTokens(c, node, u),
    interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
    upstreamFailureReason: hiddenStreamFailure,
    ...makeNodeStreamTrack(c, node, latencyMs),
  });
  return { response: new Response(tracked.body, { status: 200, headers }) };
}
