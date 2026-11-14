// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Single cross-protocol response owner. Called from legacy Inference and,
// after opt-in handoff, Protocol Center. Never schedules Provider attempts.
import { getLimits } from '../config-core/timeouts.ts';
import { EXECUTION_ERROR_CODE, EXECUTION_WIRE_RESULT, type ExecutionInvocation, INFERENCE_TRANSLATED_OBJECT_FORMAT } from '../contracts/execution.ts';
import type { GatewayEnv } from '../contracts/runtime.ts';
import { ConversionBudgetStop } from '../conversion-core/budget.ts';
import { conversionBudgetErrorChunk } from '../conversion-core/budget-error.ts';
import type { IrProtocol } from '../conversion-core/ir.ts';
import { buildFramedMatrixObjectFallback, buildFramedMatrixResponse } from '../conversion-core/matrix/framed-stream.ts';
import { replyFromNativeObject, replyToObject } from '../conversion-core/matrix/response.ts';
import { collectMatrixObject, type MatrixStreamBudget } from '../conversion-core/matrix/stream.ts';
import { protocolForSurface } from '../conversion-core/surface-protocol.ts';
import { problem } from '../execution-core/response.ts';
import { estimateAnthropicInputTokens } from '../protocol-core/anthropic.ts';
import { readBufferedReplyText } from '../transport/http.ts';

type Invocation = ExecutionInvocation;

// Versioned v5 budgeted streams and v4 legacy framing share one conversion owner.
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

/**
 * Convert one already-dispatched Provider response while preserving physical
 * quota headers, disposition, raw accounting and deadlines. No retry or fetch.
 */
export async function convertPrivateMatrixResponse(
  upstream: Response,
  invocation: Invocation,
  clientBody: Record<string, unknown>,
  env: GatewayEnv,
  signal: AbortSignal,
  outgoing: Headers,
): Promise<Response> {
  const content = upstream.headers.get('content-type');
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
      const converted = await collectMatrixObject(upstream.body, from, to, invocation.requestId, signal, bufferedResponseDeadlineMs, {
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
