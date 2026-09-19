// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import {
  classifyUpstreamStatus,
  classifyPostHeadersFailure,
  classifyClientAbort,
  classifyNonJsonBody,
  classifyEmptyResponse,
} from '../../reliability/classify.ts';
import {
  corsHeaders,
  safeReadErrorBody, trimDiagnostic,
} from '../../protocol/http.ts';
import { synthesizeSseFromCompletion } from '../../protocol/openai.ts';
import {
  collectResponsesObject, synthesizeResponsesFromObject,
} from '../../protocol/responses/index.ts';
import {
  isOpenAIChatCompletionMeaningful, isOpenAIResponsesObjectMeaningful,
  isAnthropicMessageMeaningful,
} from '../../transport/index.ts';
import {
  collectAnthropicMessageObject, synthesizeAnthropicFromMessage,
} from '../../stream/anthropic-native.ts';
import { collectOpenAIStreamObject } from '../../stream/assemble.ts';
import { trackStreamResponse } from '../../stream/track.ts';
import { reportedUsageFromPayload } from '../../observability/reported-usage.ts';
import { gatewayError, buildClientErrorResponse } from '../errors.ts';
import { finalHeaders, jsonResponse, streamInterruptionChunk, upstreamModelOf } from '../response-helpers.ts';
import { convertOpenAIToAnthropicResponse } from '../../conversion/openai-to-anthropic.ts';
import { convertAnthropicResponseToOpenAIChat } from '../../conversion/anthropic-response-to-openai-chat.ts';
import {
  recordTokens, recordNodeSuccess, makeNodeStreamTrack, recordTier1NonStreamTtft,
  recordUndeliveredUpstreamAttempt,
} from './observability.ts';
import { recordOutcome } from './outcome.ts';
import type { SuccessArgs } from './success.ts';
import type { AttemptOutcome } from '../../types/request.ts';

export async function handleObjectSuccess(s: SuccessArgs): Promise<AttemptOutcome> {
  const { upstream, c, latencyMs, detach, upstreamWasStreaming } = s;
  const { request, env, requestId, route, node, requestedModel, clientWantsStream, fakeStream, limits, exposeUpstreamInfo, state } = c;
  const elapsedSinceStart = () => Date.now() - (c.attemptStartMs as number);
  const extraHeaders = {
    'x-request-id': requestId,
    ...(exposeUpstreamInfo ? { 'x-gateway-node': node.id, 'x-gateway-tier': node.tier } : {}),
  };
  const needsModelRewrite = requestedModel !== upstreamModelOf(node, requestedModel);

  detach();

  // ---- OpenAI Responses (non-stream, NATIVE) ----
  if (route === 'openai_responses' && !c.conversionContext) {
    try {
      let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
      if (upstreamWasStreaming) data = await collectResponsesObject(upstream, request.signal, c.attemptDeadlineMs);
      else data = JSON.parse(await safeReadErrorBody(upstream, 2 * 1024 * 1024, c.attemptDeadlineMs));
      if (data && typeof data === 'object' && data.error) {
        const status = Number(data.error?.status) >= 400 && Number(data.error?.status) < 600
          ? Math.trunc(Number(data.error?.status))
          : 502;
        const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, data.error?.message || '');
        recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromPayload(data));
        recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(data.error.message || 'embedded error', 200) });
        if (classification.action === 'stop') {
          return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, JSON.stringify(data), state, exposeUpstreamInfo) };
        }
        return { rotate: true, kind: classification.kind };
      }
      if (!isOpenAIResponsesObjectMeaningful(data)) {
        const classification = classifyEmptyResponse();
        recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromPayload(data));
        recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'Responses object carried no meaningful output' });
        return { rotate: true, kind: classification.kind };
      }
      recordTier1NonStreamTtft(c, node, data, isOpenAIResponsesObjectMeaningful);
      recordTokens(c, node, data?.usage);
      if (!clientWantsStream) {
        recordNodeSuccess(c, node, latencyMs);
        if (data && typeof data === 'object') data.model = requestedModel;
        return { response: jsonResponse(200, data, env, request, extraHeaders) };
      }
      recordNodeSuccess(c, node, latencyMs);
      return { response: synthesizeResponsesFromObject(data, requestedModel, { ...extraHeaders, ...corsHeaders(request, env) }) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      const classification = classifyPostHeadersFailure(error);
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
      return { rotate: true, kind: classification.kind };
    }
  }

  // ---- OpenAI chat (non-stream, CROSS-PROTOCOL FALLBACK) ----
  if (route === 'openai_chat' && c.conversionContext) {
    try {
      let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
      if (upstreamWasStreaming) data = await collectAnthropicMessageObject(upstream, request.signal, c.attemptDeadlineMs);
      else data = JSON.parse(await safeReadErrorBody(upstream, 2 * 1024 * 1024, c.attemptDeadlineMs));
      if (data && typeof data === 'object' && (data.type === 'error' || data.error)) {
        const status = Number(data.error?.status) >= 400 && Number(data.error?.status) < 600
          ? Math.trunc(Number(data.error?.status))
          : 502;
        const message = data.error?.message || 'Upstream returned an embedded error.';
        const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, message);
        recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromPayload(data));
        recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(message, 200) });
        if (classification.action === 'stop') {
          return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, JSON.stringify(data), state, exposeUpstreamInfo) };
        }
        return { rotate: true, kind: classification.kind };
      }
      if (!isAnthropicMessageMeaningful(data)) {
        const classification = classifyEmptyResponse();
        recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromPayload(data));
        recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'cross-protocol Anthropic message carried no meaningful output' });
        return { rotate: true, kind: classification.kind };
      }
      const converted = convertAnthropicResponseToOpenAIChat(data);
      converted.model = requestedModel;
      recordNodeSuccess(c, node, latencyMs);
      // Persist the raw Anthropic usage, not the client-facing converted shape.
      recordTokens(c, node, data?.usage);
      if (clientWantsStream) return { response: synthesizeSseFromCompletion(converted, env, request, extraHeaders) };
      return { response: jsonResponse(200, converted, env, request, extraHeaders) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      const classification = classifyPostHeadersFailure(error);
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
      return { rotate: true, kind: classification.kind };
    }
  }

  // ---- OpenAI chat (non-stream, NATIVE) ----
  if (route === 'openai_chat' && !c.conversionContext) {
    if (fakeStream || (upstreamWasStreaming && !clientWantsStream)) {
      try {
        const data = await collectOpenAIStreamObject(upstream, request.signal, c.attemptDeadlineMs);
        if (!isOpenAIChatCompletionMeaningful(data)) {
          const classification = classifyEmptyResponse();
          recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromPayload(data));
          recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'assembled chat completion carried no meaningful output' });
          return { rotate: true, kind: classification.kind };
        }
        recordTier1NonStreamTtft(c, node, data, isOpenAIChatCompletionMeaningful);
        recordNodeSuccess(c, node, latencyMs);
        recordTokens(c, node, data?.usage);
        data.model = requestedModel;
        return { response: jsonResponse(200, data, env, request, extraHeaders) };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (request.signal?.aborted) {
          recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
          return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
        }
        const classification = classifyPostHeadersFailure(error);
        recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
        return { rotate: true, kind: classification.kind };
      }
    }
    if (upstreamWasStreaming) {
      const tracked = trackStreamResponse(
        new Response(upstream.body, { status: 200, headers: finalHeaders(env, request, upstream.headers, extraHeaders) }),
        {
          idleTimeoutMs: limits.streamIdleTimeoutMs,
          completionMarker: /data:\s*\[DONE\]\s*(?:\r?\n|$)/,
          ...(needsModelRewrite ? { rewriteModel: requestedModel } : {}),
          onUsage: (u: unknown) => recordTokens(c, node, u),
          interruptionChunk: (reason: string | null) => streamInterruptionChunk(route, requestId, reason),
          ...makeNodeStreamTrack(c, node, latencyMs),
        },
      );
      return { response: tracked };
    }
    const text = await safeReadErrorBody(upstream, 2 * 1024 * 1024, c.attemptDeadlineMs);
    let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
    try {
      data = JSON.parse(text);
    } catch {
      const classification = classifyNonJsonBody();
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: text });
      return { rotate: true, kind: classification.kind };
    }
    if (data && typeof data === 'object' && data.error) {
      const status = Number(data.error?.status) >= 400 && Number(data.error?.status) < 600
        ? Math.trunc(Number(data.error?.status))
        : 502;
      const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, data.error?.message || '');
      recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromPayload(data));
      recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(data.error.message || 'embedded error', 200) });
      if (classification.action === 'stop') {
        return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, text, state, exposeUpstreamInfo) };
      }
      return { rotate: true, kind: classification.kind };
    }
    if (!isOpenAIChatCompletionMeaningful(data)) {
      const classification = classifyEmptyResponse();
      recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromPayload(data));
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'chat completion carried no meaningful output' });
      return { rotate: true, kind: classification.kind };
    }
    recordTier1NonStreamTtft(c, node, data, isOpenAIChatCompletionMeaningful);
    recordTokens(c, node, data?.usage);
    if (!clientWantsStream) {
      recordNodeSuccess(c, node, latencyMs);
      if (data && typeof data === 'object') data.model = requestedModel;
      return { response: jsonResponse(200, data, env, request, extraHeaders) };
    }
    recordNodeSuccess(c, node, latencyMs);
    if (data && typeof data === 'object') data.model = requestedModel;
    return { response: synthesizeSseFromCompletion(data, env, request, extraHeaders) };
  }

  // ---- Anthropic messages (non-stream, CROSS-PROTOCOL FALLBACK) ----
  if (route === 'anthropic_messages' && c.conversionContext) {
    try {
      let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
      if (upstreamWasStreaming) data = await collectOpenAIStreamObject(upstream, request.signal, c.attemptDeadlineMs);
      else data = JSON.parse(await safeReadErrorBody(upstream, 2 * 1024 * 1024, c.attemptDeadlineMs));
      if (data && typeof data === 'object' && data.error) {
        const status = Number(data.error?.status) >= 400 && Number(data.error?.status) < 600
          ? Math.trunc(Number(data.error?.status))
          : 502;
        const message = data.error?.message || 'Upstream returned an embedded error.';
        const classification = classifyUpstreamStatus(status, upstream.headers, env, undefined, message);
        recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromPayload(data));
        recordOutcome(state, node, classification, c, { latencyMs, status, diagnostic: trimDiagnostic(message, 200) });
        if (classification.action === 'stop') {
          return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, status, JSON.stringify(data), state, exposeUpstreamInfo) };
        }
        return { rotate: true, kind: classification.kind };
      }
      if (!isOpenAIChatCompletionMeaningful(data)) {
        const classification = classifyEmptyResponse();
        recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromPayload(data));
        recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'cross-protocol OpenAI Chat completion carried no meaningful output' });
        return { rotate: true, kind: classification.kind };
      }
      const converted = convertOpenAIToAnthropicResponse(data);
      converted.model = requestedModel;
      recordNodeSuccess(c, node, latencyMs);
      // Persist raw OpenAI usage; conversion is only a client-facing concern.
      recordTokens(c, node, data?.usage);
      if (clientWantsStream) return { response: synthesizeAnthropicFromMessage(converted, { ...extraHeaders, ...corsHeaders(request, env) }) };
      return { response: jsonResponse(200, converted, env, request, extraHeaders) };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (request.signal?.aborted) {
        recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: elapsedSinceStart(), status: upstream.status });
        return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
      }
      const classification = classifyPostHeadersFailure(error);
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
      return { rotate: true, kind: classification.kind };
    }
  }

  // ---- Anthropic messages (non-stream, NATIVE) ----
  try {
    let data: (Record<string, unknown> & { error?: { status?: unknown, message?: string } }) | null;
    if (upstreamWasStreaming) data = await collectAnthropicMessageObject(upstream, request.signal, c.attemptDeadlineMs);
    else data = JSON.parse(await safeReadErrorBody(upstream, 2 * 1024 * 1024, c.attemptDeadlineMs));
    if (data && typeof data === 'object' && (data.type === 'error' || data.error)) {
      const message = data.error?.message || 'Upstream returned an embedded error.';
      const classification = classifyUpstreamStatus(502, upstream.headers, env, undefined, message);
      recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromPayload(data));
      recordOutcome(state, node, classification, c, { latencyMs, status: 502, diagnostic: trimDiagnostic(message, 200) });
      if (classification.action === 'stop') {
        return { response: buildClientErrorResponse(request, env, route, requestId, requestedModel, 502, JSON.stringify(data), state, exposeUpstreamInfo) };
      }
      return { rotate: true, kind: classification.kind };
    }
    if (!isAnthropicMessageMeaningful(data)) {
      const classification = classifyEmptyResponse();
      recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromPayload(data));
      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: 'Anthropic message carried no meaningful output' });
      return { rotate: true, kind: classification.kind };
    }
    recordTier1NonStreamTtft(c, node, data, isAnthropicMessageMeaningful);
    recordNodeSuccess(c, node, latencyMs);
    recordTokens(c, node, data?.usage);
    if (clientWantsStream) return { response: synthesizeAnthropicFromMessage(data, { ...extraHeaders, ...corsHeaders(request, env) }) };
    if (data && typeof data === 'object') data.model = requestedModel;
    return { response: jsonResponse(200, data, env, request, extraHeaders) };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (request.signal?.aborted) {
      recordOutcome(state, node, classifyClientAbort(), c, { latencyMs, status: upstream.status });
      return { response: gatewayError(request, env, route, 499, 'Client closed the request during assembly.', requestId) };
    }
    const classification = classifyPostHeadersFailure(error);
    recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorMessage });
    return { rotate: true, kind: classification.kind };
  }
}
