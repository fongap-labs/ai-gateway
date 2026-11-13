// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Gateway finalizes private Inference Center Matrix results only. It never
// parses native Provider replies or executes cross-protocol IR conversions.

import { INFERENCE_TRANSLATED_OBJECT_FORMAT, isTranslatedObjectEnvelope } from '../../../packages/contracts/execution.ts';
import { INFERENCE_FRAMED_STREAM_CONTENT_TYPE, INFERENCE_FRAMED_STREAM_FORMAT } from '../../../packages/contracts/inference-stream-frames.ts';
import { isMatrixPair } from '../../../packages/conversion-core/protocol-pairs.ts';
import { attemptFirstEventTimeoutMs, requestSizeAllowanceMs } from '../../../src/config/timeouts.ts';
import type { BudgetStopReason } from '../../../src/conversion/matrix/budget.ts';
import type { IrProtocol } from '../../../src/conversion/matrix/ir.ts';
import { isRecord } from '../../../src/conversion/matrix/ir.ts';
import { readBufferedReplyText } from '../../../src/protocol/http.ts';
import { classifyClientAbort, classifyFirstEventFailure, classifyPostHeadersFailure } from '../../../src/reliability/classify.ts';
import { markProbeFailure, recordTtft } from '../../../src/reliability/node-state.ts';
import { commitTier1RecoveryProbe, recordTier1Ttft } from '../../../src/reliability/tier1-state.ts';
import { ensureFirstSseEvent, GUARD_ERROR, guardedStreamFailureReason } from '../../../src/stream/guard.ts';
import { relayStreamResponse, trackStreamResponse } from '../../../src/stream/track.ts';
import {
  isAnthropicNativeRealOutputForConversion,
  isOpenAIChatRealOutputForConversion,
  isResponsesRealOutput,
} from '../../../src/transport/index.ts';
import type { AttemptOutcome, ConversionContext } from '../../../src/types/request.ts';
import { gatewayError } from '../response/errors.ts';
import { finalHeaders, jsonResponse, streamInterruptionChunk } from '../response/response-helpers.ts';
import { decodeFramedInferenceResponse } from '../transport/inference-stream-client.ts';
import {
  makeNodeStreamTrack,
  observeUpstreamAttemptUsage,
  recordNodeBudgetStop,
  recordNodeSuccess,
  recordTokens,
} from './observability.ts';
import { hedgeLoserOutcome, recordOutcome, stopAfterDispatchedCenterFault } from './outcome.ts';
import { isOversizedReplyError, stopOnOversizedReply } from './oversize.ts';
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

export async function handleMatrixSuccess(s: SuccessArgs): Promise<AttemptOutcome> {
  const { upstream, c, latencyMs, detach } = s;
  const { request, env, requestId, route, node, requestedModel, limits, exposeUpstreamInfo, state, policy } = c;
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

  // The center owns every physical conversion. An object response must be
  // explicitly tagged, and a streaming response must be privately framed.
  // Reject anything else BEFORE parsing the body or exposing response bytes.
  const responseFormat = upstream.headers.get('x-aig-response-format');
  const contentType = upstream.headers.get('content-type')?.toLowerCase() || '';
  if (!c.clientWantsStream) {
    if (responseFormat !== INFERENCE_TRANSLATED_OBJECT_FORMAT || !contentType.includes('application/json')) {
      detach();
      return stopAfterDispatchedCenterFault(c, gatewayError(request, env, route, 502, 'Private inference object format mismatch.', requestId));
    }
    detach();
    c.ttftMs = Date.now() - (c.attemptStartMs as number);
    if (node.tier === 'tier-1') {
      recordTier1Ttft(node.id, state.requestedModel, c.ttftMs);
      commitTier1RecoveryProbe(node.id, state.requestedModel);
    } else recordTtft(node.id, c.ttftMs, state.requestedModel);
    let native: unknown;
    try {
      native = JSON.parse(await readBufferedReplyText(upstream, c.attemptDeadlineMs));
    } catch (error) {
      if (isOversizedReplyError(error)) return stopOnOversizedReply(c, node, Date.now() - (c.attemptStartMs as number), upstream.status);
      const classification = classifyPostHeadersFailure(error);
      recordOutcome(state, node, classification, c, { latencyMs: Date.now() - (c.attemptStartMs as number), status: upstream.status });
      return { rotate: true, kind: classification.kind };
    }
    if (!isRecord(native) || !isTranslatedObjectEnvelope(native)) {
      const classification = classifyPostHeadersFailure(new Error('center returned invalid translated object envelope'));
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status });
      return { rotate: true, kind: classification.kind };
    }
    if (native.upstreamUsage !== null) observeUpstreamAttemptUsage(c, native.upstreamUsage);
    recordTokens(c, node, native.upstreamUsage);
    recordNodeSuccess(c, node, latencyMs);
    const object = { ...native.response };
    if (object.model !== undefined) object.model = requestedModel;
    return { response: jsonResponse(200, object, env, request, extraHeaders) };
  }
  if (
    !s.centerFramedStreamExpected ||
    responseFormat !== INFERENCE_FRAMED_STREAM_FORMAT ||
    !contentType.includes(INFERENCE_FRAMED_STREAM_CONTENT_TYPE)
  ) {
    detach();
    return stopAfterDispatchedCenterFault(c, gatewayError(request, env, route, 502, 'Private inference stream format mismatch.', requestId));
  }

  // ---- SSE upstream ----------------------------------------------------------
  // First-event guard BEFORE any committed byte, with the upstream protocol's
  // real-output predicate (same contract as the native and legacy paths).
  let upstreamUsage: unknown = null;
  let centerBudgetStop: BudgetStopReason | null = null;
  let guardSource: Response;
  try {
    // Only authenticated private control frames are decoded here. They contain
    // already-translated client SSE and separate physical usage metadata.
    const decoded = decodeFramedInferenceResponse(upstream, {
      onUsage: (usage) => {
        upstreamUsage = usage;
        observeUpstreamAttemptUsage(c, usage);
      },
      onBudgetStop: (reason) => {
        if (!limits.conversionBudget || centerBudgetStop !== null) {
          throw new Error('unexpected private inference budget stop');
        }
        centerBudgetStop = reason;
      },
    });
    guardSource = new Response(decoded, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } catch {
    detach();
    return stopAfterDispatchedCenterFault(c, gatewayError(request, env, route, 502, 'Invalid private inference stream.', requestId));
  }

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
    const guardProtocol = clientIr;
    const isRealOutput =
      guardProtocol === 'anthropic'
        ? isAnthropicNativeRealOutputForConversion
        : guardProtocol === 'openai_responses'
          ? isResponsesRealOutput
          : isOpenAIChatRealOutputForConversion;
    guarded = await ensureFirstSseEvent(guardSource, firstEventTimeout, request.signal, isRealOutput);
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
  if (node.tier === 'tier-1') {
    recordTier1Ttft(node.id, state.requestedModel, c.ttftMs);
    // First SSE event: same v2 probe-evidence contract as the native stream path.
    commitTier1RecoveryProbe(node.id, state.requestedModel);
  } else recordTtft(node.id, c.ttftMs, state.requestedModel);
  const hiddenStreamFailure = () => guardedStreamFailureReason(guarded);
  const headers = finalHeaders(env, request, guarded.headers, extraHeaders);

  // Conversion output budgets are enforced by Inference, not Gateway.
  const budget = limits.conversionBudget ? { mode: limits.conversionBudgetMode } : null;
  if (c.clientWantsStream) {
    const handle = { clientStream: guarded.body as ReadableStream<Uint8Array>, budgetExceeded: () => centerBudgetStop };
    // A budget stop in "error" mode is a NEUTRAL end with its own record: the
    // relay/track outcome callbacks must NOT run their success/interrupted
    // story on top of it (that would count the request as delivered or cool
    // the node for a stream interrupted by the gateway itself). "truncate"
    // mode renders a well-formed short reply instead, so the regular success
    // accounting stays in charge and no intercept is needed.
    const budgetCut = (): boolean => budget !== null && handle.budgetExceeded() !== null && budget.mode === 'error';
    let isBudgetSettled = false;
    const settleBudgetOnce = (): void => {
      if (!isBudgetSettled) {
        isBudgetSettled = true;
        recordNodeBudgetStop(c, node, handle.budgetExceeded() ?? 'unknown', 200);
      }
    };
    const base = makeNodeStreamTrack(c, node, latencyMs, { observeStreamUsage: false });
    const trackCallbacks = {
      ...base,
      onAttemptUsage: (usage: unknown, outcome: 'success' | 'failure' | 'neutral') => {
        if (budgetCut()) {
          settleBudgetOnce();
          return;
        }
        base.onAttemptUsage(usage, outcome);
      },
      onSuccess: () => {
        if (budgetCut()) {
          settleBudgetOnce();
          return;
        }
        base.onSuccess();
      },
      onFailure: () => {
        if (budgetCut()) {
          settleBudgetOnce();
          return;
        }
        base.onFailure();
      },
      onNeutral: () => {
        if (budgetCut()) {
          settleBudgetOnce();
          return;
        }
        base.onNeutral();
      },
      onStreamEnd: (
        outcome: string,
        d: { reason: string | null; durationMs: number; chunkCount: number; receivedBytes: number; completionMarkerSeen: boolean },
      ) => {
        if (budgetCut()) return; // the [conversion-budget] log line stands in
        base.onStreamEnd(outcome, d);
      },
    };
    const guardedUsage = () => {
      if (!budgetCut()) recordTokens(c, node, upstreamUsage);
    };

    // AIG_STREAM_PASSTHROUGH: the matrix has ALREADY translated the bytes once,
    // so running the per-chunk decode + completion/usage/error/rewrite scans a
    // SECOND time on the client stream only burns isolate CPU. Relay instead;
    // delivered usage flows through the collector callback below.
    if (limits.streamPassthrough) {
      const relayed = relayStreamResponse(new Response(handle.clientStream, { status: 200, headers }), {
        idleTimeoutMs: limits.streamIdleTimeoutMs,
        protocol: clientIr,
        ...trackCallbacks,
        onUsage: guardedUsage,
      });
      return { response: relayed };
    }

    const tracked = trackStreamResponse(new Response(handle.clientStream, { status: 200, headers }), {
      idleTimeoutMs: limits.streamIdleTimeoutMs,
      protocol: clientIr,
      onUsage: guardedUsage,
      interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
      upstreamFailureReason: hiddenStreamFailure,
      ...trackCallbacks,
    });
    return { response: tracked };
  }
  // No client-side object assembly is permitted in the Gateway.
  return stopAfterDispatchedCenterFault(c, gatewayError(request, env, route, 502, 'Unexpected private inference response type.', requestId));
}
