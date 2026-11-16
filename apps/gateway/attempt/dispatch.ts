// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs


import { hasImageInput } from '../../../packages/contracts/image-input.ts';
import { withNativeSpan } from '../../../packages/contracts/native-tracing.ts';
import { getProviderProfile } from '../../../packages/contracts/provider-profiles.ts';
import { createInternalTraceparent } from '../../../packages/contracts/trace-context.ts';
import { modelRegistryEntry } from '../../../src/config/registry.ts';
import { recordAttemptEvent } from '../../../src/observability/gateway-events.ts';
import { logLazy } from '../../../src/observability/logger.ts';
import { KIND } from '../../../src/reliability/classify.ts';
import type { AttemptContext, AttemptOutcome } from '../../../src/types/request.ts';
import { gatewayError } from '../response/errors.ts';
import { upstreamModelOf } from '../response/response-helpers.ts';
import { dispatchGenerationAttempt } from './generation-dispatch.ts';
import { dispatchInferenceAttempt } from './inference-dispatch.ts';
import { recordUndeliveredUpstreamAttempt } from './observability.ts';
import { rotateWithNeutralEnd } from './outcome.ts';

export { isBufferedUpstreamReply } from './attempt-mode.ts';

export async function attemptNode(c: AttemptContext): Promise<AttemptOutcome> {
  return withNativeSpan(
    c.ctx,
    'aig.gateway.attempt',
    { requestId: c.requestId, nodeId: c.node.id, model: c.reqDescriptor.model, center: 'gateway', phase: 'dispatch' },
    () => attemptNodeUntraced(c),
    (span, outcome) => {
      span.setAttribute('aig.result', outcome.response?.ok ? 'ok' : (outcome.kind ?? 'other'));
      span.setAttribute('aig.status', outcome.response?.status ?? c.upstreamStatus ?? 0);
      if (c.headersMs !== undefined && c.headersMs >= 0) span.setAttribute('aig.headers_ms', c.headersMs);
      if (c.traceparent) span.setAttribute('aig.span_id', c.traceparent.split('-')[2] ?? '');
    },
  );
}

async function attemptNodeUntraced(c: AttemptContext): Promise<AttemptOutcome> {
  const previouslyAttempted = c.state.logicalAttempts > 0;
  const outcome = await dispatchAttempt(c);
  if (outcome.budgetCharged !== false) {
    recordAttemptEvent(c.env, {
      nodeId: c.node.id,
      provider: c.node.provider,
      tier: c.node.tier,
      model: c.reqDescriptor.model,
      outcome: outcome.response?.ok ? 'ok' : (outcome.kind ?? (outcome.response?.status === 499 ? 'client_abort' : 'client')),
      role: c.hedgedAttempt ? 'hedge' : previouslyAttempted ? 'retry' : 'primary',
      route: c.route,
      status: c.upstreamStatus ?? 0,
      headersMs: c.headersMs ?? -1,
      ttftMs: c.ttftMs ?? -1,
      latencyMs: c.attemptStartMs ? Date.now() - c.attemptStartMs : -1,
    });
  }
  if (outcome.hedgedAway) recordUndeliveredUpstreamAttempt(c, c.node);
  if (outcome.budgetCharged === undefined) outcome.budgetCharged = true;
  if (outcome.response?.ok) {
    c.state.dispatches++;
    if (!c.hedgedAttempt) c.state.logicalAttempts++;
    const effectiveModel = c.reqDescriptor.model;
    const successfulStatus = outcome.response.status;
    logLazy(
      c.logger,
      'debug',
      () =>
        `dispatch request=${c.requestId} logical_attempt=${c.state.logicalAttempts}/${c.state.maxAttempts}` +
        ` dispatch=${c.state.dispatches} node=${c.node.id} provider=${c.node.provider}` +
        ` protocol=${c.upstreamProtocol ?? c.node.protocol} surface=${c.surface} tier=${c.node.tier}` +
        `${c.traceparent ? ` trace_span_id=${c.traceparent.split('-')[2]}` : ''}` +
        ` model=${c.requestedModel}${effectiveModel !== c.requestedModel ? `=>${effectiveModel}` : ''}->${upstreamModelOf(c.node, effectiveModel)}` +
        ` hedged=${!!(c.hedgedAttempt || c.hedgedWithTwin)} kind=ok status=${successfulStatus}` +
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
  c.traceparent = createInternalTraceparent(c.requestId) ?? undefined;
  c.attemptSettlement = { observedUsage: null, settled: false };
  const upstreamProtocol = conversionContext ? conversionContext.fallbackProtocol : node.protocol;
  c.upstreamProtocol = upstreamProtocol;
  const surface = conversionContext ? conversionContext.fallbackSurface : reqDescriptor.surface;
  c.surface = surface;
  const sourceBody = conversionContext ? conversionContext.convertedBody : bodyJson;

  if (route === 'openai_images') return dispatchGenerationAttempt(c);
  if (c.imageInputRequired ?? hasImageInput(bodyJson)) {
    const visionDeclared = modelRegistryEntry(c.env, reqDescriptor.model).catalog.capabilities.vision === true;
    const providerAcceptsImages = getProviderProfile(node.provider).imageInput;
    if (!visionDeclared) {
      return {
        budgetCharged: false,
        response: gatewayError(
          c.request,
          c.env,
          route,
          400,
          'Image input is unavailable for the requested model and provider.',
          c.requestId,
          undefined,
          undefined,
          'gateway_image_input_unsupported',
        ),
      };
    }
    if (!providerAcceptsImages) return rotateWithNeutralEnd(c.state, node, KIND.AUTH, c, true);
    return dispatchInferenceAttempt(c, sourceBody, 'perception');
  }
  return dispatchInferenceAttempt(c, sourceBody, 'inference');
}
