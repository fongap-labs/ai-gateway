// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Success layer for IR-matrix conversions: the upstream speaks a foreign
// protocol (`fallbackProtocol`/`fallbackSurface`), the matrix decode/encode
// round-trip produces the client protocol. Non-streaming clients are served
// from the collected reply (the upstream is ALWAYS forced into streaming for
// matrix conversions by convertMatrixRequest). Every cross-protocol pair is
// matrix-owned; native passes carry no conversion context and never land here.

import { attemptFirstEventTimeoutMs } from '../../config/timeouts.ts';
import type { IrProtocol } from '../../conversion/matrix/ir.ts';
import { isRecord } from '../../conversion/matrix/ir.ts';
import {
  collectMatrixObject,
  isMatrixPair,
  openMatrixStream,
  replyFromNativeObject,
  replyToObject,
  synthesizeMatrixStreamFromObject,
} from '../../conversion/matrix/pipeline.ts';
import { estimateAnthropicInputTokens } from '../../protocol/anthropic.ts';
import { isOpenAIStreamingResponse } from '../../protocol/openai.ts';
import { classifyClientAbort, classifyFirstEventFailure, classifyPostHeadersFailure } from '../../reliability/classify.ts';
import { markProbeFailure, recordTtft } from '../../reliability/node-state.ts';
import { recordTier1Ttft } from '../../reliability/tier1-state.ts';
import { ensureFirstSseEvent, GUARD_ERROR, guardedStreamFailureReason } from '../../stream/guard.ts';
import { trackStreamResponse } from '../../stream/track.ts';
import { isAnthropicNativeRealOutputForConversion, isOpenAIChatRealOutputForConversion, isResponsesRealOutput } from '../../transport/index.ts';
import type { AttemptOutcome, ConversionContext } from '../../types/request.ts';
import { gatewayError } from '../errors.ts';
import { finalHeaders, jsonResponse, streamInterruptionChunk } from '../response-helpers.ts';
import { makeNodeStreamTrack, observeUpstreamAttemptUsage, recordNodeSuccess, recordTokens } from './observability.ts';
import { hedgeLoserOutcome, recordOutcome } from './outcome.ts';
import type { SuccessArgs } from './success.ts';

/** True when this conversion context is owned by the IR matrix (any pair). */
export function isMatrixConversion(conversionContext: ConversionContext | null | undefined): boolean {
  if (!conversionContext) return false;
  const from = protocolToIr(conversionContext.clientRoute);
  const to = fallbackToIr(conversionContext.fallbackProtocol, conversionContext.fallbackSurface);
  if (!from || !to) return false;
  return isMatrixPair(from, to);
}

function protocolToIr(route: string): IrProtocol | null {
  switch (route) {
    case 'openai_chat':
      return 'openai_chat';
    case 'openai_responses':
      return 'openai_responses';
    case 'anthropic_messages':
      return 'anthropic';
    default:
      return null;
  }
}

function fallbackToIr(protocol: string, surface: string): IrProtocol | null {
  if (protocol === 'openai' && surface === 'chat_completions') return 'openai_chat';
  if (protocol === 'openai' && surface === 'responses') return 'openai_responses';
  if (protocol === 'anthropic' && surface === 'messages') return 'anthropic';
  return null;
}

const COMPLETION_MARKERS: Record<IrProtocol, RegExp> = {
  openai_chat: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
  anthropic: /event:\s*message_stop\b/,
  openai_responses: /event:\s*response\.(?:completed|incomplete)\b/,
};

export async function handleMatrixSuccess(s: SuccessArgs): Promise<AttemptOutcome> {
  const { upstream, c, latencyMs, detach } = s;
  const { request, env, requestId, route, node, requestedModel, limits, exposeUpstreamInfo, state, policy } = c;
  const bodyJson = c.bodyJson as Record<string, unknown>;
  const conversionContext = c.conversionContext;
  if (!conversionContext) return { rotate: true, kind: classifyPostHeadersFailure(new Error('matrix success without conversion context')).kind };
  const upstreamIr = fallbackToIr(conversionContext.fallbackProtocol, conversionContext.fallbackSurface);
  const clientIr = protocolToIr(route);
  if (!upstreamIr || !clientIr)
    return { rotate: true, kind: classifyPostHeadersFailure(new Error('matrix conversion has an unresolvable protocol pair')).kind };
  const extraHeaders = {
    'x-request-id': requestId,
    ...(exposeUpstreamInfo ? { 'x-gateway-node': node.id, 'x-gateway-tier': node.tier } : {}),
  };

  // The matrix request body always forces stream:true. A JSON upstream here
  // means the provider ignored the streaming flag (or never streamed at all):
  // translate the native object through IR instead of mis-serving a foreign
  // payload shape. Anything else that is not SSE rotates as a post-headers
  // failure.
  if (!upstream.ok) {
    detach();
    const classification = classifyPostHeadersFailure(new Error('matrix upstream rejected the conversion request'));
    return { rotate: true, kind: classification.kind };
  }
  const upstreamStreaming = isOpenAIStreamingResponse(upstream);

  // ---- JSON upstream (provider ignored stream:true) -------------------------
  if (!upstreamStreaming) {
    detach();
    c.ttftMs = Date.now() - (c.attemptStartMs as number);
    if (node.tier === 'tier-1') recordTier1Ttft(node.id, state.requestedModel, c.ttftMs);
    else recordTtft(node.id, c.ttftMs, state.requestedModel);
    let native: unknown;
    try {
      native = await upstream.json();
    } catch (error) {
      const classification = classifyPostHeadersFailure(error);
      recordOutcome(state, node, classification, c, { latencyMs: Date.now() - (c.attemptStartMs as number), status: upstream.status });
      return { rotate: true, kind: classification.kind };
    }
    if (!isRecord(native)) {
      const classification = classifyPostHeadersFailure(new Error('matrix upstream returned a non-object body'));
      recordOutcome(state, node, classification, c, { latencyMs: Date.now() - (c.attemptStartMs as number), status: upstream.status });
      return { rotate: true, kind: classification.kind };
    }
    const { reply } = replyFromNativeObject(upstreamIr, native);
    if (reply.rawUsage !== undefined && reply.rawUsage !== null) observeUpstreamAttemptUsage(c, reply.rawUsage);
    if (!reply.parts.some((p) => p.type === 'text' && p.text) && !reply.parts.some((p) => p.type === 'tool_call')) {
      return { rotate: true, kind: classifyPostHeadersFailure(new Error('matrix response carried no meaningful output')).kind };
    }
    recordNodeSuccess(c, node, latencyMs);
    recordTokens(c, node, reply.rawUsage);
    if (c.clientWantsStream) {
      return { response: synthesizeMatrixStreamFromObject(reply, clientIr) };
    }
    const object = replyToObject(reply, clientIr) as Record<string, unknown>;
    if (object.model !== undefined) object.model = requestedModel;
    return { response: jsonResponse(200, object, env, request, extraHeaders) };
  }

  // ---- SSE upstream ----------------------------------------------------------
  // First-event guard BEFORE any committed byte, with the upstream protocol's
  // real-output predicate (same contract as the native and legacy paths).
  const guardStartMs = Date.now();
  let guarded: Response;
  try {
    const remainingRequestBudgetMs =
      (c.failoverBudgetMs ?? limits.failoverBudgetMs) - (Date.now() - (c.requestStartMs || (s.attemptStartMs as number) || Date.now()));
    const remainingAttemptBudgetMs = (c.attemptDeadlineMs ?? Date.now()) - Date.now();
    const effectiveFirstEventTimeoutMs = policy?.firstEventTimeoutMs ?? limits.firstEventTimeoutMs;
    const firstEventTimeout = attemptFirstEventTimeoutMs(
      effectiveFirstEventTimeoutMs,
      Math.min(remainingRequestBudgetMs, remainingAttemptBudgetMs),
      1,
    );
    const isRealOutput =
      upstreamIr === 'anthropic'
        ? isAnthropicNativeRealOutputForConversion
        : upstreamIr === 'openai_responses'
          ? isResponsesRealOutput
          : isOpenAIChatRealOutputForConversion;
    guarded = await ensureFirstSseEvent(upstream, firstEventTimeout, request.signal, isRealOutput, (event: unknown) => {
      // Usage observer consumes the RAW upstream lifecycle event.
      observeUpstreamAttemptUsage(c, event);
    });
  } catch (e) {
    detach();
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : GUARD_ERROR.EMPTY;
    const ttftWaitMs = Date.now() - guardStartMs;
    if (request.signal?.aborted) {
      recordOutcome(state, node, classifyClientAbort(), c, {
        latencyMs: Date.now() - (c.attemptStartMs as number),
        ttftWaitMs,
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
      ttftWaitMs,
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
  // Anthropic input-token estimate for usage accounting parity with the legacy
  // conversion path (rawUsage otherwise reports only what the upstream sent).
  const seedInputTokens = upstreamIr === 'anthropic' ? estimateAnthropicInputTokens(bodyJson) : 0;
  const fallbackId = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  let upstreamUsage: unknown = null;

  if (c.clientWantsStream) {
    const handle = openMatrixStream(guarded.body, upstreamIr, clientIr, fallbackId, {
      onUpstreamUsage: (u) => {
        upstreamUsage = u;
        // Raw upstream usage feeds accounting; the translated client shape is
        // cosmetic and must not enter node token statistics.
        observeUpstreamAttemptUsage(c, u);
      },
    });
    const tracked = trackStreamResponse(new Response(handle.clientStream, { status: 200, headers }), {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      completionMarker: COMPLETION_MARKERS[clientIr],
      onUsage: () => recordTokens(c, node, upstreamUsage),
      interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
      upstreamFailureReason: hiddenStreamFailure,
      ...makeNodeStreamTrack(c, node, latencyMs, { observeStreamUsage: false }),
    });
    return { response: tracked };
  }

  try {
    // Non-streaming clients: collect the upstream stream through IR and render
    // the client object in one pass (single decode path).
    const collected = await collectMatrixObject(guarded.body, upstreamIr, clientIr, fallbackId, request.signal, c.attemptDeadlineMs, {
      seedInputTokens,
      onUpstreamUsage: (raw) => {
        upstreamUsage = raw;
        observeUpstreamAttemptUsage(c, raw);
      },
    });
    const reply = collected.reply;
    const object = collected.object as Record<string, unknown>;
    if (!reply.parts.some((p) => p.type === 'text' && p.text) && !reply.parts.some((p) => p.type === 'tool_call')) {
      return { rotate: true, kind: classifyPostHeadersFailure(new Error('matrix response carried no meaningful output')).kind };
    }
    recordNodeSuccess(c, node, latencyMs);
    recordTokens(c, node, reply.rawUsage ?? upstreamUsage);
    if (object.model !== undefined) object.model = requestedModel;
    return { response: jsonResponse(200, object, env, request, extraHeaders) };
  } catch (error) {
    if (request.signal?.aborted) {
      recordTokens(c, node, upstreamUsage);
      return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
    }
    if (c.hedgeAbort?.signal.aborted) {
      return hedgeLoserOutcome(c, node, 'object', latencyMs);
    }
    const classification = classifyPostHeadersFailure(error);
    return { rotate: true, kind: classification.kind };
  }
}
