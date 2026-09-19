// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { attemptFirstEventTimeoutMs } from '../../config/timeouts.ts';
import { markProbeFailure, recordTtft, recordNeutralEnd, bumpNodeCounters } from '../../reliability/node-state.ts';
import { recordTier1Ttft, releaseTier1Slot } from '../../reliability/tier1-state.ts';
import {
  classifyFirstEventFailure,
  classifyClientAbort,
  classifyHedgeRaceLoss,
} from '../../reliability/classify.ts';
import { estimateAnthropicInputTokens } from '../../protocol/anthropic.ts';
import {
  isAnthropicNativeRealOutput, isAnthropicNativeRealOutputForConversion,
  isResponsesRealOutput, isOpenAIChatRealOutput, isOpenAIChatRealOutputForConversion,
} from '../../transport/index.ts';
import { ensureFirstSseEvent, GUARD_ERROR, guardedStreamFailureReason } from '../../stream/guard.ts';
import { trackStreamResponse } from '../../stream/track.ts';
import { reportedUsageFromPayload } from '../../observability/reported-usage.ts';
import { mergeReportedUsage } from '../../observability/token-usage.ts';
import { gatewayError } from '../errors.ts';
import { finalHeaders, streamInterruptionChunk, upstreamModelOf } from '../response-helpers.ts';
import { createAnthropicStreamFromOpenAI } from '../../conversion/stream-converter.ts';
import { createOpenAIChatStreamFromAnthropic } from '../../conversion/anthropic-stream-to-openai-chat.ts';
import {
  recordTokens, makeNodeStreamTrack,
  observeUpstreamAttemptUsage, recordUndeliveredUpstreamAttempt,
} from './observability.ts';
import { recordOutcome } from './outcome.ts';
import type { SuccessArgs } from './success.ts';
import type { AttemptOutcome } from '../../types/request.ts';

export async function handleStreamingSuccess(s: SuccessArgs): Promise<AttemptOutcome> {
  const { upstream, c, latencyMs, detach } = s;
  const { request, env, logger, requestId, route, node, requestedModel, bodyJson, limits, exposeUpstreamInfo, state, policy } = c;
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
    const remainingRequestBudgetMs = (c.failoverBudgetMs ?? limits.failoverBudgetMs) - (Date.now() - (c.requestStartMs || (s.attemptStartMs as number) || Date.now()));
    const remainingAttemptBudgetMs = (c.attemptDeadlineMs ?? Date.now()) - Date.now();
    const effectiveFirstEventTimeoutMs = policy?.firstEventTimeoutMs ?? limits.firstEventTimeoutMs;
    const firstEventTimeout = attemptFirstEventTimeoutMs(
      effectiveFirstEventTimeoutMs,
      Math.min(remainingRequestBudgetMs, remainingAttemptBudgetMs),
      1,
    );
    const isRealOutput = c.conversionContext
      ? (c.conversionContext.fallbackProtocol === 'anthropic'
          ? isAnthropicNativeRealOutputForConversion
          : isOpenAIChatRealOutputForConversion)
      : surface === 'messages'
        ? isAnthropicNativeRealOutput
        : surface === 'responses' ? isResponsesRealOutput
        : surface === 'chat_completions' ? isOpenAIChatRealOutput
        : undefined;
    guarded = await ensureFirstSseEvent(
      upstream,
      firstEventTimeout,
      request.signal,
      isRealOutput,
      (event: unknown) => {
        const usage = reportedUsageFromPayload(event);
        if (usage != null) observeUpstreamAttemptUsage(c, usage);
      },
    );
  } catch (e) {
    detach();
    const code = (e && typeof e === 'object' && 'code' in e) ? String((e as { code: unknown }).code) : GUARD_ERROR.EMPTY;
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
      recordUndeliveredUpstreamAttempt(c, node);
      state.attempted.add(node.id);
      state.dispatches++;
      if (!c.hedgedAttempt) state.logicalAttempts++;
      if (node.tier === 'tier-1') {
        releaseTier1Slot(node.id, c.tier1ReleaseToken);
        bumpNodeCounters(node.id, { requests: 1 });
      } else recordNeutralEnd(node.id);
      logger.info(
        `hedge loser: request=${requestId} node=${node.id} phase=first_event`
        + ` reason=cancelled_after_peer_commit neutral=true latency_ms=${Date.now() - (c.attemptStartMs as number)}`,
      );
      return { rotate: true, hedgedAway: true, kind: classifyHedgeRaceLoss().kind };
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
  if (node.tier === 'tier-1') recordTier1Ttft(node.id, state.requestedModel, c.ttftMs);
  else recordTtft(node.id, c.ttftMs, state.requestedModel);
  const hiddenStreamFailure = () => guardedStreamFailureReason(guarded);
  const headers = finalHeaders(env, request, guarded.headers, extraHeaders);

  if (route === 'openai_chat' && !c.conversionContext) {
    const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      completionMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
      ...(needsModelRewrite ? { rewriteModel: requestedModel } : {}),
      onUsage: (u: unknown) => recordTokens(c, node, u),
      interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
      upstreamFailureReason: hiddenStreamFailure,
      ...makeNodeStreamTrack(c, node, latencyMs),
    });
    return { response: tracked };
  }

  if (route === 'openai_chat' && c.conversionContext) {
    let upstreamUsage: unknown = null;
    const openAiStream = createOpenAIChatStreamFromAnthropic(guarded.body, {
      messageId: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      model: requestedModel,
      onUpstreamUsage: (u: unknown) => {
        upstreamUsage = mergeReportedUsage(upstreamUsage, u);
        // Raw Anthropic usage is the accounting source of truth. The
        // translated OpenAI usage chunk is client-facing only and can omit
        // Anthropic-specific cache creation/read fields.
        observeUpstreamAttemptUsage(c, u);
      },
    });
    const tracked = trackStreamResponse(
      new Response(openAiStream, { status: 200, headers }),
      {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        completionMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
        ...(needsModelRewrite ? { rewriteModel: requestedModel } : {}),
        onUsage: () => recordTokens(c, node, upstreamUsage),
        interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
        upstreamFailureReason: hiddenStreamFailure,
        ...makeNodeStreamTrack(c, node, latencyMs, { observeStreamUsage: false }),
      },
    );
    return { response: new Response(tracked.body, { status: 200, headers }) };
  }

  if (route === 'openai_responses' && !c.conversionContext) {
    const tracked = trackStreamResponse(new Response(guarded.body, { status: 200, headers }), {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      completionMarker: /event:\s*response\.(?:completed|incomplete)\b/,
      failureMarker: /event:\s*response\.failed\b/,
      ...(needsModelRewrite ? { rewriteModel: requestedModel, rewriteModelAt: 'response.model' } : {}),
      onUsage: (u: unknown) => recordTokens(c, node, u),
      interruptionChunk: (reason: string | null, details?: { nextSequenceNumber?: number }) => streamInterruptionChunk(route, requestId, reason, details),
      upstreamFailureReason: hiddenStreamFailure,
      ...makeNodeStreamTrack(c, node, latencyMs),
    });
    return { response: tracked };
  }

  if (route === 'anthropic_messages' && c.conversionContext) {
    const inputTokens = estimateAnthropicInputTokens(bodyJson);
    const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    let upstreamUsage: unknown = null;
    const anthropicStream = createAnthropicStreamFromOpenAI(guarded.body, {
      messageId,
      model: requestedModel,
      inputTokens,
      onUpstreamUsage: (u: unknown) => {
        upstreamUsage = mergeReportedUsage(upstreamUsage, u);
        // This is the raw OpenAI provider report. The Anthropic stream also
        // contains a synthetic message_start usage derived from the local
        // input-token estimate; that synthetic value must never enter
        // upstream accounting.
        observeUpstreamAttemptUsage(c, u);
      },
    });
    const tracked = trackStreamResponse(
      new Response(anthropicStream, { status: 200, headers }),
      {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        completionMarker: /event:\s*message_stop\b/,
        // A clean delivery still counts even when the upstream omitted usage;
        // recordTokens(null) records coverage-missing without inventing tokens.
        onUsage: () => recordTokens(c, node, upstreamUsage),
        interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
        upstreamFailureReason: hiddenStreamFailure,
        ...makeNodeStreamTrack(c, node, latencyMs, { observeStreamUsage: false }),
      },
    );
    return { response: new Response(tracked.body, { status: 200, headers }) };
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
