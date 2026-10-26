// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Part of src/request/attempt.ts (behavior-preserving split); see
// attempt/index.ts for the module map.

// dispatch.ts - one attempt against one node: outbound preparation (URL,
// headers, body, conversion context), reserve-aware attempt deadline,
// the upstream fetch, and the classification entry points for non-OK /
// network / client-abort outcomes. Success handling lives in success.ts;
// the hedge race lives in hedge.ts.

import { attemptBudgetWindowMs, attemptHeadersTimeoutMs, requestSizeAllowanceMs } from '../../config/timeouts.ts';
import { getOAuthProvider } from '../../oauth/provider-configs.ts';
import { resolveSubscriptionCredential } from '../../oauth/resolve.ts';
import { recordAttemptEvent } from '../../observability/gateway-events.ts';
import { reportedUsageFromJsonText } from '../../observability/reported-usage.ts';
import { buildTargetUrl, MAX_BUFFERED_REPLY_BYTES, readBodyTextBounded, safeReadErrorBody } from '../../protocol/http.ts';
import { isOpenAIStreamingResponse, withUsageStreamOptions } from '../../protocol/openai.ts';
import { getProviderAdapter, streamUsageEnabled } from '../../providers/registry.ts';
import {
  classifyClientAbort,
  classifyEmptyResponse,
  classifyNetworkError,
  classifyNonJsonBody,
  classifyPreDispatchInvalidBaseUrl,
  classifyUpstreamStatus,
  KIND,
} from '../../reliability/classify.ts';
import { extractQuotaSignal } from '../../reliability/quota-signal.ts';
import { recordTier1QuotaReport } from '../../reliability/tier1-state.ts';
import { isSubscriptionNode } from '../../subscription/index.ts';
import type { SubscriptionWire } from '../../subscription/types.ts';
import { buildUpstreamHeadersFor, resolveUpstreamPath } from '../../transport/index.ts';
import type { AttemptContext, AttemptOutcome } from '../../types/request.ts';
import { buildClientErrorResponse, gatewayError } from '../errors.ts';
import { upstreamModelOf } from '../response-helpers.ts';
import { LARGE_BODY_CHARS } from './body-release.ts';
import { recordUndeliveredUpstreamAttempt } from './observability.ts';
import { hedgeLoserOutcome, recordOutcome, rotateWithNeutralEnd } from './outcome.ts';
import { stopOnOversizedReply } from './oversize.ts';
import { handleSuccess } from './success.ts';

const DIAGNOSTIC_BYTES = 4096;

// AttemptContext and AttemptOutcome are defined in src/types/request.ts
// (the cross-module source of truth). attempt.ts receives its context from
// handler.ts via dispatchWithHedge(args, tierNodes).

/**
 * True when the upstream is asked for one buffered JSON reply. A matrix
 * translation always asks the upstream to stream, and a streaming client or the
 * stream guard (fakeStream) makes the upstream stream as well.
 */
export function isBufferedUpstreamReply(c: Pick<AttemptContext, 'conversionContext' | 'clientWantsStream' | 'fakeStream'>): boolean {
  return !c.conversionContext && !c.clientWantsStream && !c.fakeStream;
}

// ---- One attempt against one node -----------------------------------------

// Wrapper around dispatchAttempt. Every path inside either contacted (or tried
// to contact) an upstream - charging failover budget by default - or opted out
// explicitly on a pre-dispatch path. Normalizing here guarantees every outcome
// carries a defined `budgetCharged`, so the main loop never has to infer
// charging from a failure-kind string. Successful dispatches get one debug
// line here (failures log their own dispatch line inside recordOutcome), so
// every upstream dispatch emits exactly one completion record.
export async function attemptNode(c: AttemptContext): Promise<AttemptOutcome> {
  const outcome = await dispatchAttempt(c);
  if (outcome.budgetCharged !== false) {
    recordAttemptEvent(c.env, {
      nodeId: c.node.id,
      provider: c.node.provider,
      tier: c.node.tier,
      model: c.reqDescriptor.model,
      outcome: outcome.response?.ok ? 'ok' : (outcome.kind ?? (outcome.response?.status === 499 ? 'client_abort' : 'client')),
      role: c.hedgedAttempt ? 'hedge' : c.state.hasRetriedSameNode ? 'retry' : 'primary',
      route: c.route,
      status: c.upstreamStatus ?? 0,
      headersMs: c.headersMs ?? -1,
      ttftMs: c.ttftMs ?? -1,
      latencyMs: c.attemptStartMs ? Date.now() - c.attemptStartMs : -1,
    });
  }
  // Some hedge-loss paths intentionally bypass recordOutcome() because they are
  // neutral reliability outcomes. They still contacted an upstream, so close
  // the physical-attempt accounting slot here. The settlement helper is
  // idempotent, therefore the headers-phase hedge path (which settles earlier)
  // is not double-counted.
  if (outcome.hedgedAway) recordUndeliveredUpstreamAttempt(c, c.node);
  if (outcome.budgetCharged === undefined) outcome.budgetCharged = true;
  if (outcome.response?.ok) {
    // Successful dispatches never pass through recordOutcome, so charge them
    // here - exactly once, like every failure/neutral path. A committed
    // response reached an upstream, so it always charges the dispatch count;
    // a hedge twin still never charges the logical attempt.
    c.state.dispatches++;
    if (!c.hedgedAttempt) c.state.logicalAttempts++;
    const effectiveModel = c.reqDescriptor.model;
    c.logger.debug(
      `dispatch request=${c.requestId} logical_attempt=${c.state.logicalAttempts}/${c.state.maxAttempts}` +
        ` dispatch=${c.state.dispatches} node=${c.node.id} provider=${c.node.provider}` +
        ` protocol=${c.upstreamProtocol ?? c.node.protocol} surface=${c.surface} tier=${c.node.tier}` +
        ` model=${c.requestedModel}${effectiveModel !== c.requestedModel ? `=>${effectiveModel}` : ''}->${upstreamModelOf(c.node, effectiveModel)}` +
        ` hedged=${!!(c.hedgedAttempt || c.hedgedWithTwin)} kind=ok status=${outcome.response.status}` +
        ` headers_ms=${c.headersMs ?? -1}${c.ttftMs !== undefined ? ` ttft_ms=${c.ttftMs}` : ''}` +
        ` latency_ms=${c.attemptStartMs ? Date.now() - c.attemptStartMs : -1}`,
    );
  }
  return outcome;
}

async function dispatchAttempt(c: AttemptContext): Promise<AttemptOutcome> {
  const {
    request,
    env,
    logger,
    requestId,
    route,
    node,
    requestedModel,
    fakeStream,
    bodyJson,
    rawBody,
    limits,
    exposeUpstreamInfo,
    state,
    failoverBudgetMs,
    requestStartMs,
    remainingDispatchableAttempts,
    reqDescriptor,
    policy,
    conversionContext,
  } = c;
  const attemptStartMs = Date.now();
  c.attemptStartMs = attemptStartMs;
  // One settlement holder per physical dispatch. Every terminal path of this
  // attempt (success, failure, hedge loss, client abort) settles through it, so
  // the physical attempt is written to the token statistics exactly once. The
  // holder is created here, before any copy of this context is made, so a copy
  // (the model-family fallback rewrites the node) still settles THIS attempt.
  c.attemptSettlement = { observedUsage: null, settled: false };
  // For cross-protocol fallback the upstream protocol/surface come from the
  // conversion context (the fallback target), NOT from the node's native
  // protocol. The transport must use the FALLBACK protocol so the right
  // upstream path, headers and stream semantics are used. The node's own
  // protocol stays correct for the native path.
  const upstreamProtocol = conversionContext ? conversionContext.fallbackProtocol : node.protocol;
  c.upstreamProtocol = upstreamProtocol;
  const surface = conversionContext ? conversionContext.fallbackSurface : reqDescriptor.surface;
  c.surface = surface;
  const sourceBody = conversionContext ? conversionContext.convertedBody : bodyJson;

  // `requestedModel` is the client-facing identity and remains stable across
  // transparent model-family fallback. `reqDescriptor.model` is the effective
  // logical alias currently being routed. The node mapping MUST use the latter
  // so a Max request transparently falling back to Pro resolves the Pro
  // upstream mapping while the response can still be rewritten to Max.
  const effectiveModel = reqDescriptor.model;
  const upstreamModel = node.models[effectiveModel] || effectiveModel;
  let isBodyMutated = false;
  let outboundObject: Record<string, unknown>;
  if (route === 'openai_chat' && !conversionContext) {
    outboundObject = { ...sourceBody, model: upstreamModel };
    if (fakeStream) {
      outboundObject.stream = true;
      isBodyMutated = true;
    }
  } else if (conversionContext && conversionContext.fallbackSurface === 'chat_completions') {
    outboundObject = { ...sourceBody, model: upstreamModel, ...(fakeStream ? { stream: true } : {}) };
  } else {
    // openai_responses -> native /v1/responses body
    // anthropic_messages -> native /v1/messages body
    // Matrix-converted bodies already force stream:true upstream; every
    // non-chat surface (and any unrecognized surface) lands here unchanged
    // beyond the model rewrite.
    outboundObject = { ...sourceBody, model: upstreamModel };
  }
  // Ask the OpenAI-chat upstream to report usage in the final streaming chunk.
  // This is a passive protocol hint (include_usage) that changes nothing the
  // client sees and is gated by provider quirks + operator switches, so an
  // upstream that rejects the field can be opted out per provider. The field
  // only exists on the OpenAI chat_completions wire format - native Responses
  // and Anthropic bodies are never touched. Non-stream requests already carry
  // usage in the body and are never touched here.
  if (surface === 'chat_completions' && outboundObject.stream === true && streamUsageEnabled(node, env)) {
    outboundObject = withUsageStreamOptions(outboundObject);
    isBodyMutated = true;
  }

  // Tier 2 subscription nodes resolve their credential from the OAuth token
  // store at dispatch time (isolate cache first; D1/refresh only on miss),
  // then hand the resolved credential to the provider's subscription
  // adapter, which owns the subscription-specific request shape (headers,
  // body normalization). Adapter or resolution failure is a pre-dispatch
  // auth end: no upstream contact, no physical attempt accounting, and the
  // node rotates for this request. isSubscriptionNode is the single binding
  // between "subscription entitlement" and the credential form that proves
  // it; the request path never checks node.auth directly.
  let credential = node.credential;
  let subscriptionExtraHeaders: Readonly<Record<string, string>> | undefined;
  let subscriptionWire: SubscriptionWire | undefined;
  let subscriptionUpstreamUrl: string | null = null;
  if (isSubscriptionNode(node)) {
    const resolved = await resolveSubscriptionCredential(env, node);
    if (!resolved.ok) {
      logger.info(`oauth credential resolution failed node=${node.id} reason=${resolved.reason}`);
      return rotateWithNeutralEnd(state, node, KIND.AUTH, c, true);
    }
    credential = resolved.token;
    const adapter = getProviderAdapter(node.provider).subscription;
    const providerConfig = getOAuthProvider(env, node.provider);
    if (!adapter) {
      logger.info(`oauth credential resolved but no subscription adapter exists node=${node.id} provider=${node.provider}`);
      return rotateWithNeutralEnd(state, node, KIND.AUTH, c, true);
    }
    const prepared = adapter.prepare({
      node,
      credential: resolved,
      request,
      body: outboundObject,
      surface,
    });
    if (!prepared) {
      logger.info(`subscription adapter refused dispatch node=${node.id} provider=${node.provider}`);
      return rotateWithNeutralEnd(state, node, KIND.AUTH, c, true);
    }
    if (prepared.body) {
      outboundObject = prepared.body;
      isBodyMutated = true;
    }
    subscriptionWire = adapter.wire;
    subscriptionUpstreamUrl = prepared.upstreamUrl;
    // Adapter headers win over provider-config headers; both are
    // deployment/first-party values, never client identity material.
    subscriptionExtraHeaders = {
      ...(providerConfig?.upstreamHeaders || {}),
      ...prepared.headers,
    };
  }
  const canReuseRawBody =
    rawBody !== undefined &&
    rawBody.text.length > 0 &&
    !isBodyMutated &&
    !conversionContext &&
    !isSubscriptionNode(node) &&
    typeof bodyJson.model === 'string' &&
    bodyJson.model === upstreamModel;
  let outboundBody: string;
  if (canReuseRawBody && rawBody) {
    outboundBody = rawBody.text;
  } else {
    // Drop the original before allocating its replacement string so a large
    // mutated/converted body does not hold two full-size copies at peak.
    if (rawBody && rawBody.text.length > LARGE_BODY_CHARS) rawBody.text = '';
    outboundBody = JSON.stringify(outboundObject);
  }

  let targetUrl: URL | string;
  try {
    targetUrl = subscriptionUpstreamUrl
      ? new URL(subscriptionUpstreamUrl).toString()
      : buildTargetUrl(node.baseUrl, resolveUpstreamPath(upstreamProtocol, surface));
  } catch {
    return rotateWithNeutralEnd(state, node, classifyPreDispatchInvalidBaseUrl().kind, c, true);
  }

  const headers = buildUpstreamHeadersFor(
    upstreamProtocol,
    request,
    credential,
    requestId,
    isSubscriptionNode(node) ? { auth: 'oauth', extraHeaders: subscriptionExtraHeaders } : undefined,
  );
  const controller = new AbortController();
  let hasHeadersTimeoutHit = false;
  const hedgeAbort = c.hedgeAbort;
  if (hedgeAbort) {
    // Forward the hedge race verdict ("Hedge lost" from hedge.ts) into the
    // underlying fetch so the losing node's connection is cut at the winner's
    // commit instant (first token for streams, complete response otherwise).
    const onHedgeAbort = () => controller.abort(hedgeAbort.signal.reason);
    if (hedgeAbort.signal.aborted) onHedgeAbort();
    else hedgeAbort.signal.addEventListener('abort', onHedgeAbort, { once: true });
  }
  // A large prompt legitimately waits longer for its first byte (prefill), and a
  // buffered (non-stream) reply sends no headers until generation has finished,
  // so for it the header wait IS the generation wait and is bounded by the
  // attempt window instead of the streaming-oriented header timeout. Otherwise
  // every non-stream completion longer than the header timeout fails here, fails
  // over to an equally slow node and ends in a 504.
  const configuredHeadersMs = (policy.headersTimeoutMs ?? limits.headersTimeoutMs) + requestSizeAllowanceMs(reqDescriptor.bodyChars);
  const isBufferedReply = isBufferedUpstreamReply(c);
  let attemptHeadersTimeout: number;
  if (c.hedgedAttempt && c.attemptDeadlineMs) {
    const windowMs = Math.max(1, c.attemptDeadlineMs - Date.now());
    attemptHeadersTimeout = attemptHeadersTimeoutMs(isBufferedReply ? Math.max(configuredHeadersMs, windowMs) : configuredHeadersMs, windowMs, 1);
  } else {
    const remainingBudgetMs = failoverBudgetMs - (Date.now() - requestStartMs);
    const windowMs = attemptBudgetWindowMs(remainingBudgetMs, remainingDispatchableAttempts);
    // A streaming attempt that can hand over to a sibling model gives up early.
    // The window bounds only the header and first-event waits, not the stream.
    const attemptBudgetMs = !isBufferedReply && c.attemptCapMs ? Math.min(windowMs, c.attemptCapMs) : windowMs;
    c.attemptDeadlineMs = Date.now() + attemptBudgetMs;
    attemptHeadersTimeout = attemptHeadersTimeoutMs(
      isBufferedReply || c.takeRemainingWindow ? Math.max(configuredHeadersMs, attemptBudgetMs) : configuredHeadersMs,
      attemptBudgetMs,
      1,
    );
  }
  const timeoutId = setTimeout(() => {
    hasHeadersTimeoutHit = true;
    controller.abort();
  }, attemptHeadersTimeout);
  const onClientAbort = () => controller.abort();
  if (request.signal?.aborted) onClientAbort();
  else request.signal?.addEventListener('abort', onClientAbort, { once: true });
  const detach = () => request.signal?.removeEventListener('abort', onClientAbort);

  const startMs = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: outboundBody,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    detach();
    const latencyMs = Date.now() - startMs;
    if (request.signal?.aborted && !hasHeadersTimeoutHit) {
      recordOutcome(state, node, classifyClientAbort(), c, { latencyMs });
      return { response: gatewayError(request, env, route, 499, 'Client closed the request.', requestId) };
    }
    if (c.hedgeAbort?.signal.aborted) {
      // A peer committed first. This still was a real physical dispatch, but
      // it is a neutral reliability end and carries no successful-delivery
      // evidence. Finalize its upstream-attempt accounting before returning.
      return hedgeLoserOutcome(c, node, 'headers', latencyMs);
    }
    const classification = classifyNetworkError(hasHeadersTimeoutHit);
    recordOutcome(state, node, classification, c, { latencyMs });
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.debug(`upstream fetch failed on ${node.id}: ${errorMessage}`);
    return { rotate: true, kind: classification.kind };
  } finally {
    // The body has been uploaded (or the upload failed) by now. Large bodies
    // are never hedged, so the holder no longer needs to keep them alive.
    if (rawBody && rawBody.text.length > LARGE_BODY_CHARS) rawBody.text = '';
  }
  clearTimeout(timeoutId);
  const latencyMs = Date.now() - startMs;
  c.headersMs = latencyMs;
  c.upstreamStatus = upstream.status;

  // Provider-reported quota windows arrive on response headers for both success
  // and error responses. Feed them into the Tier 1 quota state so the dormant
  // near_limit scoring and exhausted_until gate activate before the next 429,
  // and the reservation counter tracks the real window tail. Unknown quota
  // (no markers) produces no signal and changes nothing.
  if (node.tier === 'tier-1') {
    recordTier1QuotaReport(node.id, extractQuotaSignal(upstreamProtocol, upstream.headers, Date.now()));
  }

  // ---- Non-OK response ----
  if (!upstream.ok) {
    detach();
    const errorText = await safeReadErrorBody(upstream, DIAGNOSTIC_BYTES, c.attemptDeadlineMs);
    let classification = classifyUpstreamStatus(upstream.status, upstream.headers, env, undefined, errorText);
    // Subscription entitlement windows: the provider adapter owns the
    // interpretation of quota-reset markers (resets_at / window-reset).
    // The hint can only EXTEND the rate-limit cooldown, never shorten it,
    // and stays capped inside the adapter — recovery remains the normal
    // cooldown-expiry -> probe -> restore flow.
    if (isSubscriptionNode(node) && classification.kind === 'rate_limit') {
      const quotaAdapter = getProviderAdapter(node.provider).subscription;
      const hint = quotaAdapter?.quotaResetHint
        ? quotaAdapter.quotaResetHint({ status: upstream.status, headers: upstream.headers, body: errorText }, Date.now())
        : null;
      if (hint !== null && hint > classification.cooldownMs) {
        classification = { ...classification, cooldownMs: hint };
      }
      // A subscription window-reset hint also marks the quota window exhausted
      // until the reset instant, so the eligibility gate and reservation counter
      // reflect the entitlement boundary — not just the cooldown.
      if (node.tier === 'tier-1' && hint !== null && hint > 0) {
        recordTier1QuotaReport(node.id, { remainingRequests: 0, resetAtMs: Date.now() + hint, source: 'subscription-window' });
      }
    }
    // Some compatible providers include usage even on an HTTP error. Preserve
    // only that explicit report; malformed/non-JSON bodies remain "missing".
    recordUndeliveredUpstreamAttempt(c, node, reportedUsageFromJsonText(errorText));
    recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: errorText });
    if (classification.action === 'stop') {
      return {
        response: buildClientErrorResponse(request, env, route, requestId, requestedModel, upstream.status, errorText, state, exposeUpstreamInfo),
      };
    }
    return { rotate: true, kind: classification.kind };
  }

  // Subscription proprietary wire: convert the OK upstream response into the
  // node's native protocol shape before the success layer consumes it, so
  // every success/stream/object handler keeps one consistent contract. A
  // streaming proprietary body is converted lazily (the converter emits the
  // native terminal marker and never before real output, so the first-event
  // guard can still rotate); a non-streaming body is converted eagerly here.
  // A conversion that finds no meaningful output is an empty-response
  // rotation, mirroring the native paths.
  if (subscriptionWire) {
    if (isOpenAIStreamingResponse(upstream)) {
      const nativeBody = subscriptionWire.streamToNative(upstream.body, {
        messageId: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        model: requestedModel,
      });
      const wireHeaders = new Headers();
      wireHeaders.set('content-type', 'text/event-stream');
      const buffering = upstream.headers.get('x-accel-buffering');
      if (buffering) wireHeaders.set('x-accel-buffering', buffering);
      upstream = new Response(nativeBody, { status: 200, headers: wireHeaders });
    } else {
      const read = await readBodyTextBounded(upstream, MAX_BUFFERED_REPLY_BYTES, c.attemptDeadlineMs);
      if (read.isTruncated) return stopOnOversizedReply(c, node, latencyMs, upstream.status);
      const text = read.text;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        recordUndeliveredUpstreamAttempt(c, node);
        const nonJson = classifyNonJsonBody();
        recordOutcome(state, node, nonJson, c, { latencyMs, status: upstream.status, diagnostic: text });
        return { rotate: true, kind: nonJson.kind };
      }
      const nativeObject = subscriptionWire.objectToNative(parsed);
      if (!nativeObject) {
        recordUndeliveredUpstreamAttempt(c, node);
        const empty = classifyEmptyResponse();
        recordOutcome(state, node, empty, c, {
          latencyMs,
          status: upstream.status,
          diagnostic: 'subscription wire response carried no meaningful output',
        });
        return { rotate: true, kind: empty.kind };
      }
      upstream = new Response(JSON.stringify(nativeObject), {
        status: 200,
        headers: { 'content-type': 'application/json;charset=UTF-8' },
      });
    }
  }

  const successNode = effectiveModel === requestedModel ? node : { ...node, models: { ...node.models, [requestedModel]: upstreamModel } };
  const successContext = successNode === node ? c : { ...c, node: successNode };

  return handleSuccess({
    upstream,
    c: successContext,
    targetUrl,
    latencyMs,
    detach,
    upstreamWasStreaming: isOpenAIStreamingResponse(upstream),
  });
}
