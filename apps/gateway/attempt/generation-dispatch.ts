// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// A private generation invocation is one potentially billable operation.
// Unknown outcomes and center faults are terminal; never retry behind the
// user's back or silently use the legacy direct-provider path.

import { EXECUTION_WIRE_RESULT, parseExecutionResponse } from '../../../packages/contracts/execution.ts';
import { attemptBudgetWindowMs } from '../../../src/config/timeouts.ts';
import { safeReadErrorBody } from '../../../src/protocol/http.ts';
import { classifyClientAbort, classifyUpstreamStatus, KIND } from '../../../src/reliability/classify.ts';
import { recordTier1QuotaReport } from '../../../src/reliability/tier1-state.ts';
import type { AttemptContext, AttemptOutcome } from '../../../src/types/request.ts';
import { quotaFromCenter } from '../reliability/center-quota.ts';
import { gatewayError } from '../response/errors.ts';
import { GenerationCenterUnavailable, invokeGenerationNode } from '../transport/generation-client-request.ts';
import { recordUndeliveredUpstreamAttempt } from './observability.ts';
import { recordOutcome, rotateWithNeutralEnd } from './outcome.ts';
import { handleSuccess } from './success.ts';

function terminate(c: AttemptContext, status: number, code: string, message: string, hasAttemptedProvider = false): AttemptOutcome {
  const { request, env, route, node, state, requestId } = c;
  if (hasAttemptedProvider) {
    recordUndeliveredUpstreamAttempt(c, node);
    rotateWithNeutralEnd(state, node, KIND.NETWORK, c);
  } else {
    rotateWithNeutralEnd(state, node, KIND.AUTH, c, true);
  }
  return {
    budgetCharged: hasAttemptedProvider,
    response: gatewayError(request, env, route, status, message, requestId, undefined, undefined, code),
  };
}

export async function dispatchGenerationAttempt(c: AttemptContext): Promise<AttemptOutcome> {
  const { request, env, node, reqDescriptor, state, route, requestId } = c;
  const remainingMs = c.failoverBudgetMs - (Date.now() - c.requestStartMs);
  const windowMs = attemptBudgetWindowMs(remainingMs, c.remainingDispatchableAttempts);
  if (remainingMs <= 0 || windowMs <= 0) {
    return terminate(c, 504, 'gateway_generation_deadline_expired', 'Image-generation deadline expired.');
  }
  c.attemptDeadlineMs = Math.min(Date.now() + windowMs, c.requestStartMs + c.failoverBudgetMs, Date.now() + 540_000);
  const effectiveModel = reqDescriptor.model;
  const outboundBody = JSON.stringify({ ...c.bodyJson, model: effectiveModel });
  if (c.rawBody && c.rawBody.text.length > 50_000) c.rawBody.text = '';

  const controller = new AbortController();
  const deadlineMs = c.attemptDeadlineMs - Date.now();
  if (deadlineMs <= 0) return terminate(c, 504, 'gateway_generation_deadline_expired', 'Image-generation deadline expired.');
  const timeoutId = setTimeout(() => controller.abort(), deadlineMs);
  const abort = () => controller.abort();
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });
  const detach = () => request.signal.removeEventListener('abort', abort);

  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await invokeGenerationNode(env, {
      request,
      requestId,
      traceparent: c.traceparent,
      node,
      logicalModel: effectiveModel,
      deadlineMs: c.attemptDeadlineMs,
      body: outboundBody,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    detach();
    if (error instanceof GenerationCenterUnavailable) {
      return terminate(c, 503, 'gateway_generation_center_unavailable', 'Private image-generation center is unavailable.');
    }
    if (request.signal.aborted) {
      recordOutcome(state, node, classifyClientAbort(), c, { latencyMs: Date.now() - startedAt });
      return { response: gatewayError(request, env, route, 499, 'Client closed image generation request.', requestId) };
    }
    // A Service Binding call can fail after executing upstream. Unknown means
    // terminal even if the timeout fired and no response headers arrived.
    return terminate(c, 502, 'gateway_generation_outcome_unknown', 'Image-generation outcome is unknown; not retried.', true);
  }
  clearTimeout(timeoutId);
  c.headersMs = Date.now() - startedAt;
  c.upstreamStatus = upstream.status;

  const result = parseExecutionResponse(upstream).result;
  if (result === EXECUTION_WIRE_RESULT.ATTEMPTED) {
    detach();
    return terminate(c, 502, 'gateway_generation_outcome_unknown', 'Image-generation outcome is unknown; not retried.', true);
  }
  if (result !== EXECUTION_WIRE_RESULT.DISPATCHED) {
    detach();
    return terminate(c, 503, 'gateway_generation_center_rejected', 'Private image-generation center refused the request.');
  }

  if (node.tier === 'tier-1') {
    recordTier1QuotaReport(node.id, quotaFromCenter(upstream.headers));
  }

  if (!upstream.ok) {
    detach();
    const errorText = await safeReadErrorBody(upstream, 4096, c.attemptDeadlineMs);
    const classification = classifyUpstreamStatus(upstream.status, upstream.headers, env, undefined, errorText);
    recordOutcome(state, node, classification, c, { latencyMs: c.headersMs, status: upstream.status });
    // These statuses are explicit pre-generation rejections; other errors
    // might represent a paid generation and MUST NOT be replayed.
    if (upstream.status === 429 || upstream.status === 404) return { rotate: true, kind: classification.kind };
    return {
      response: gatewayError(
        request,
        env,
        route,
        502,
        'Image generation failed at the upstream; retry disabled.',
        requestId,
        undefined,
        undefined,
        'gateway_generation_upstream_failed',
      ),
    };
  }
  if (upstream.headers.get('x-aig-generation-normalized') !== 'true') {
    detach();
    return terminate(c, 502, 'gateway_generation_contract_invalid', 'Private image-generation response contract was invalid.', true);
  }
  return handleSuccess({
    upstream,
    c,
    targetUrl: 'https://generation.internal/internal/execute',
    latencyMs: c.headersMs,
    detach,
    upstreamWasStreaming: false,
  });
}
