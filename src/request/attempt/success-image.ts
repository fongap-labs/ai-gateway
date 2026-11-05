// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Image generation is a terminal paid operation once submitted. We must not
// retry a provider that has already returned a 2xx with malformed output:
// it may have charged for the image even if we cannot decode its response.

import { readBodyTextBounded } from '../../protocol/http.ts';
import { getProviderAdapter } from '../../providers/registry.ts';
import { classifyClientAbort, classifyEmptyResponse, KIND } from '../../reliability/classify.ts';
import type { AttemptOutcome } from '../../types/request.ts';
import { gatewayError } from '../errors.ts';
import { jsonResponse } from '../response-helpers.ts';
import { recordNodeSuccess } from './observability.ts';
import { recordOutcome, rotateWithNeutralEnd } from './outcome.ts';
import type { SuccessArgs } from './success.ts';

const MAX_IMAGE_REPLY_BYTES = 16 * 1024 * 1024;

export async function handleImageSuccess(s: SuccessArgs): Promise<AttemptOutcome> {
  const { upstream, c, latencyMs, detach } = s;
  const { request, env, route, requestId, node, state } = c;
  detach();
  if (request.signal?.aborted) {
    recordOutcome(state, node, classifyClientAbort(), c, { latencyMs, status: upstream.status });
    return { response: gatewayError(request, env, route, 499, 'Client closed image generation request.', requestId) };
  }
  const adapter = getProviderAdapter(node.provider).image;
  if (!adapter) {
    rotateWithNeutralEnd(state, node, KIND.CLIENT, c);
    return { response: gatewayError(request, env, route, 502, 'Image provider adapter is unavailable.', requestId, undefined, undefined, 'gateway_image_adapter_missing') };
  }
  const result = await readBodyTextBounded(upstream, MAX_IMAGE_REPLY_BYTES, c.attemptDeadlineMs);
  if (result.isTruncated) {
    rotateWithNeutralEnd(state, node, KIND.CLIENT, c);
    return {
      response: gatewayError(request, env, route, 502, 'Image provider response exceeds the bounded reply limit.', requestId, undefined, undefined, 'gateway_image_reply_too_large'),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    recordOutcome(state, node, classifyEmptyResponse(), c, { latencyMs, status: upstream.status });
    return { response: gatewayError(request, env, route, 502, 'Image provider returned invalid JSON.', requestId, undefined, undefined, 'gateway_image_reply_invalid') };
  }
  const image = adapter.extract(parsed);
  if (!image) {
    recordOutcome(state, node, classifyEmptyResponse(), c, { latencyMs, status: upstream.status });
    return { response: gatewayError(request, env, route, 502, 'Image provider returned no supported base64 image.', requestId, undefined, undefined, 'gateway_image_reply_invalid') };
  }
  recordNodeSuccess(c, node, latencyMs);
  // The result is not a text token response and must not enter token-usage
  // counters. Never log or persist the base64 payload.
  return {
    response: jsonResponse(200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: image }] }, env, request, {
      'x-request-id': requestId,
      'cache-control': 'no-store',
    }),
  };
}
