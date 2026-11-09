// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Success layer for IR-matrix conversions: the upstream speaks a foreign
// protocol (`fallbackProtocol`/`fallbackSurface`), the matrix decode/encode
// round-trip produces the client protocol. Non-streaming clients are served
// from the collected reply; by convertMatrixRequest the upstream is forced
// into streaming (or, with AIG_CONVERSION_PREFER_NONSTREAM, allowed to answer
// with one JSON body, which this file's JSON branch already handles). Every
// cross-protocol pair is matrix-owned; native passes carry no conversion
// context and never land here.

import { INFERENCE_TRANSLATED_OBJECT_FORMAT, isTranslatedObjectEnvelope } from '../../../packages/contracts/execution.ts';
import { INFERENCE_FRAMED_STREAM_FORMAT } from '../../../packages/contracts/inference-stream-frames.ts';
import { isMatrixPair } from '../../../packages/conversion-core/protocol-pairs.ts';
import { attemptFirstEventTimeoutMs, requestSizeAllowanceMs } from '../../../src/config/timeouts.ts';
import { type BudgetStopReason, ConversionBudgetStop } from '../../../src/conversion/matrix/budget.ts';
import type { IrProtocol } from '../../../src/conversion/matrix/ir.ts';
import { isRecord } from '../../../src/conversion/matrix/ir.ts';
import {
  collectMatrixObject,
  openMatrixStream,
  replyFromNativeObject,
  replyToObject,
  synthesizeMatrixStreamFromObject,
} from '../../../src/conversion/matrix/pipeline.ts';
import { estimateAnthropicInputTokens } from '../../../src/protocol/anthropic.ts';
import { readBufferedReplyText } from '../../../src/protocol/http.ts';
import { isOpenAIStreamingResponse } from '../../../src/protocol/openai.ts';
import {
  classifyClientAbort,
  classifyConversionBudget,
  classifyFirstEventFailure,
  classifyPostHeadersFailure,
} from '../../../src/reliability/classify.ts';
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
  recordUndeliveredUpstreamAttempt,
} from './observability.ts';
import { hedgeLoserOutcome, recordOutcome } from './outcome.ts';
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

// The SSE frames the matrix stream ends with when the AIG_CONVERSION_BUDGET
// expired in "error" mode. Route-specific strait of streamInterruptionChunk
// with the budget wording; OpenAI Chat additionally gets the [DONE] sentinel
// after the terminal error payload (the truncation mode renders its own
// well-formed terminal frames through the encoder instead — no chunk here).
function conversionBudgetErrorChunk(route: string, requestId: string): Uint8Array {
  const base = streamInterruptionChunk(route, requestId, null, {
    message: 'Gateway conversion output budget exceeded.',
    code: 'conversion_budget_exceeded',
  });
  if (route === 'openai_chat') {
    const done = streamErrorEncoder.encode('data: [DONE]\n\n');
    const out = new Uint8Array(base.byteLength + done.byteLength);
    out.set(base, 0);
    out.set(done, base.byteLength);
    return out;
  }
  return base;
}

const streamErrorEncoder = new TextEncoder();

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
  const isFramed = s.centerFramedStreamExpected && upstream.headers.get('x-aig-response-format') === INFERENCE_FRAMED_STREAM_FORMAT;
  if (s.centerFramedStreamExpected && upstream.headers.has('x-aig-response-format') && !isFramed) {
    detach();
    recordUndeliveredUpstreamAttempt(c, node);
    return { response: gatewayError(request, env, route, 502, 'Private inference stream format mismatch.', requestId) };
  }
  const upstreamStreaming = isFramed || isOpenAIStreamingResponse(upstream);

  // ---- JSON upstream (provider ignored stream:true) -------------------------
  if (!upstreamStreaming) {
    detach();
    c.ttftMs = Date.now() - (c.attemptStartMs as number);
    if (node.tier === 'tier-1') {
      recordTier1Ttft(node.id, state.requestedModel, c.ttftMs);
      // A full upstream object is richer probe evidence than headers alone;
      // the v2 gate commits here once upstream.ok is established.
      commitTier1RecoveryProbe(node.id, state.requestedModel);
    } else recordTtft(node.id, c.ttftMs, state.requestedModel);
    let native: unknown;
    try {
      native = await readBufferedReplyText(upstream, c.attemptDeadlineMs).then((text) => JSON.parse(text));
    } catch (error) {
      if (isOversizedReplyError(error)) return stopOnOversizedReply(c, node, Date.now() - (c.attemptStartMs as number), upstream.status);
      const classification = classifyPostHeadersFailure(error);
      recordOutcome(state, node, classification, c, { latencyMs: Date.now() - (c.attemptStartMs as number), status: upstream.status });
      return { rotate: true, kind: classification.kind };
    }
    if (!isRecord(native)) {
      const classification = classifyPostHeadersFailure(new Error('matrix upstream returned a non-object body'));
      recordOutcome(state, node, classification, c, { latencyMs: Date.now() - (c.attemptStartMs as number), status: upstream.status });
      return { rotate: true, kind: classification.kind };
    }
    // A v3 center object is already in the client protocol. Treat its raw
    // usage as physical upstream usage exactly once; DO NOT decode/re-encode
    // its payload through the Matrix pipeline again.
    if (upstream.headers.get('x-aig-response-format') === INFERENCE_TRANSLATED_OBJECT_FORMAT) {
      if (!isTranslatedObjectEnvelope(native) || c.clientWantsStream) {
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
    const { reply } = replyFromNativeObject(upstreamIr, native);
    if (reply.rawUsage !== undefined && reply.rawUsage !== null) observeUpstreamAttemptUsage(c, reply.rawUsage);
    if (!reply.parts.some((p) => p.type === 'text' && p.text) && !reply.parts.some((p) => p.type === 'tool_call')) {
      const classification = classifyPostHeadersFailure(new Error('matrix response carried no meaningful output'));
      recordOutcome(state, node, classification, c, {
        latencyMs,
        status: upstream.status,
        diagnostic: 'matrix response carried no meaningful output',
      });
      return { rotate: true, kind: classification.kind };
    }
    recordTokens(c, node, reply.rawUsage);
    recordNodeSuccess(c, node, latencyMs);
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
  let upstreamUsage: unknown = null;
  let centerBudgetStop: BudgetStopReason | null = null;
  let guardSource = upstream;
  if (isFramed) {
    try {
      // Decode private frames before Gateway's first-public-event guard.
      // Usage is recorded from the physical Provider, never from the client
      // format, and the client cannot receive the private control frames.
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
      recordUndeliveredUpstreamAttempt(c, node);
      return { response: gatewayError(request, env, route, 502, 'Invalid private inference stream.', requestId) };
    }
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
    const guardProtocol = isFramed ? clientIr : upstreamIr;
    const isRealOutput =
      guardProtocol === 'anthropic'
        ? isAnthropicNativeRealOutputForConversion
        : guardProtocol === 'openai_responses'
          ? isResponsesRealOutput
          : isOpenAIChatRealOutputForConversion;
    guarded = await ensureFirstSseEvent(guardSource, firstEventTimeout, request.signal, isRealOutput, (event: unknown) => {
      if (!isFramed) observeUpstreamAttemptUsage(c, event);
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
  if (node.tier === 'tier-1') {
    recordTier1Ttft(node.id, state.requestedModel, c.ttftMs);
    // First SSE event: same v2 probe-evidence contract as the native stream path.
    commitTier1RecoveryProbe(node.id, state.requestedModel);
  } else recordTtft(node.id, c.ttftMs, state.requestedModel);
  const hiddenStreamFailure = () => guardedStreamFailureReason(guarded);
  const headers = finalHeaders(env, request, guarded.headers, extraHeaders);

  // AIG_CONVERSION_BUDGET wiring (limits-derived, flag-off keeps everything
  // below byte-identical to the legacy behavior).
  const budget = limits.conversionBudget
    ? {
        cfg: { ...limits.conversionBudgetCfg, maxOutputTokens: limits.conversionBudgetMaxTokens },
        mode: limits.conversionBudgetMode,
        stopChunk: conversionBudgetErrorChunk(route, requestId),
      }
    : null;

  // Anthropic input-token estimate for usage accounting parity with the legacy
  // conversion path (rawUsage otherwise reports only what the upstream sent).
  const seedInputTokens = upstreamIr === 'anthropic' ? estimateAnthropicInputTokens(bodyJson) : 0;
  const fallbackId = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  if (c.clientWantsStream) {
    const handle = isFramed
      ? { clientStream: guarded.body as ReadableStream<Uint8Array>, budgetExceeded: () => centerBudgetStop }
      : openMatrixStream(guarded.body, upstreamIr, clientIr, fallbackId, {
          model: requestedModel,
          onUpstreamUsage: (u) => {
            upstreamUsage = u;
            // Raw upstream usage feeds accounting; the translated client shape
            // is cosmetic and must not enter node token statistics.
            observeUpstreamAttemptUsage(c, u);
          },
          ...(budget ? { budget: { cfg: budget.cfg, mode: budget.mode, stopChunk: budget.stopChunk } } : {}),
        });
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

  try {
    // Non-streaming clients: collect the upstream stream through IR and render
    // the client object in one pass (single decode path).
    const collected = await collectMatrixObject(guarded.body, upstreamIr, clientIr, fallbackId, request.signal, c.attemptDeadlineMs, {
      seedInputTokens,
      model: requestedModel,
      onUpstreamUsage: (raw) => {
        upstreamUsage = raw;
        observeUpstreamAttemptUsage(c, raw);
      },
      ...(budget ? { budget: { cfg: { ...budget.cfg, maxOutputUnits: limits.conversionNonstreamMaxUnits }, mode: budget.mode } } : {}),
    });
    const reply = collected.reply;
    const object = collected.object as Record<string, unknown>;
    if (!reply.parts.some((p) => p.type === 'text' && p.text) && !reply.parts.some((p) => p.type === 'tool_call')) {
      const classification = classifyPostHeadersFailure(new Error('matrix response carried no meaningful output'));
      recordOutcome(state, node, classification, c, {
        latencyMs,
        status: upstream.status,
        diagnostic: 'matrix response carried no meaningful output',
      });
      return { rotate: true, kind: classification.kind };
    }
    recordTokens(c, node, reply.rawUsage ?? upstreamUsage);
    recordNodeSuccess(c, node, latencyMs);
    if (object.model !== undefined) object.model = requestedModel;
    return { response: jsonResponse(200, object, env, request, extraHeaders) };
  } catch (error) {
    // Budget stop in "error" mode: the oversized translated reply would be
    // regenerated (and billed) identically on any other node, so stop the
    // request with a 502 that names the budget — mirroring the oversized-reply
    // terminal — while the node takes no reliability blame. In "truncate"
    // mode this cannot fire: collectMatrixObject seals a well-formed short
    // reply instead of throwing.
    if (error instanceof ConversionBudgetStop) {
      const classification = classifyConversionBudget();
      recordOutcome(state, node, classification, c, {
        latencyMs: Date.now() - (c.attemptStartMs as number),
        status: guarded.status,
        diagnostic: error.message,
      });
      return {
        response: gatewayError(
          request,
          env,
          route,
          502,
          'The translated reply exceeds the gateway conversion output budget. Retry with a smaller request.',
          requestId,
          undefined,
          undefined,
          'conversion_budget_exceeded',
        ),
      };
    }
    if (request.signal?.aborted) {
      // The client received no model output, so this attempt is a physical
      // upstream attempt only. Recording it as delivered would inflate the
      // public request counter and the TTFT evidence with a request that never
      // completed. The usage observed on the wire is still settled through the
      // attempt's upstream-attempt accounting.
      recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: Date.now() - (c.attemptStartMs as number), status: guarded.status });
      return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
    }
    if (c.hedgeAbort?.signal.aborted) {
      return hedgeLoserOutcome(c, node, 'object', latencyMs);
    }
    const classification = classifyPostHeadersFailure(error);
    recordOutcome(state, node, classification, c, {
      latencyMs: Date.now() - (c.attemptStartMs as number),
      status: guarded.status,
      diagnostic: error instanceof Error ? error.message : String(error),
    });
    return { rotate: true, kind: classification.kind };
  }
}
