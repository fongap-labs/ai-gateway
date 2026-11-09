// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Request-level attempt accounting; all execution is private-center owned.
// An unavailable center always fails closed, never to a direct Provider.

import { recordAttemptEvent } from '../../../src/observability/gateway-events.ts';
import { dispatchGenerationAttempt } from '../../../src/request/attempt/generation-dispatch.ts';
import { dispatchInferenceAttempt } from '../../../src/request/attempt/inference-dispatch.ts';
import type { AttemptContext, AttemptOutcome } from '../../../src/types/request.ts';
import { upstreamModelOf } from '../response/response-helpers.ts';
import { recordUndeliveredUpstreamAttempt } from './observability.ts';

export { isBufferedUpstreamReply } from './attempt-mode.ts';

// Every Provider call is charged once, including hedge losers. The Gateway
// owns the request-level attempt/hedge budget; centers execute one attempt.
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
  const { route, node, reqDescriptor, conversionContext, bodyJson } = c;
  const attemptStartMs = Date.now();
  c.attemptStartMs = attemptStartMs;
  // Created BEFORE the physical attempt and before any hedge context copies.
  c.attemptSettlement = { observedUsage: null, settled: false };
  const upstreamProtocol = conversionContext ? conversionContext.fallbackProtocol : node.protocol;
  c.upstreamProtocol = upstreamProtocol;
  const surface = conversionContext ? conversionContext.fallbackSurface : reqDescriptor.surface;
  c.surface = surface;
  const sourceBody = conversionContext ? conversionContext.convertedBody : bodyJson;

  // Image generation is non-idempotent and must always use the private center.
  // A missing Service Binding or auth key fails closed (503); never dispatch a
  // paid generation directly from Gateway or silently retry another Provider.
  if (route === 'openai_images') return dispatchGenerationAttempt(c);
  // The Gateway never owns Provider credentials or outbound network calls.
  // A missing/invalid Service Binding is classified by dispatchInferenceAttempt
  // as a neutral 503; it MUST NOT trigger a legacy direct-provider fallback.
  return dispatchInferenceAttempt(c, sourceBody);
}
