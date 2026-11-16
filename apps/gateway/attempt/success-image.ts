import { corsHeaders, readBodyTextBounded } from '../../../src/protocol/http.ts';
import { getProviderAdapter } from '../../../src/providers/registry.ts';
import { classifyClientAbort, classifyEmptyResponse, KIND } from '../../../src/reliability/classify.ts';
import type { AttemptOutcome } from '../../../src/types/request.ts';
import { gatewayError } from '../response/errors.ts';
import { jsonResponse } from '../response/response-helpers.ts';
import { recordNodeSuccess } from './observability.ts';
import { recordOutcome, rotateWithNeutralEnd } from './outcome.ts';
import type { SuccessArgs } from './success.ts';

const MAX_IMAGE_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_STREAMED_IMAGE_BYTES = 16 * 1024 * 1024;

export async function handleImageSuccess(s: SuccessArgs): Promise<AttemptOutcome> {
  const { upstream, c, latencyMs, detach } = s;
  const { request, env, route, requestId, node, state } = c;
  detach();
  if (request.signal?.aborted) {
    recordOutcome(state, node, classifyClientAbort(), c, { latencyMs, status: upstream.status });
    return { response: gatewayError(request, env, route, 499, 'Client closed image generation request.', requestId) };
  }
  if (upstream.headers.get('x-aig-generation-normalized') === 'true') {
    const reported = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(reported) && reported > MAX_STREAMED_IMAGE_BYTES) {
      rotateWithNeutralEnd(state, node, KIND.CLIENT, c);
      return {
        response: gatewayError(request, env, route, 502, 'Image response exceeds the maximum stream size.', requestId),
      };
    }
    recordNodeSuccess(c, node, latencyMs);
    return {
      response: new Response(upstream.body, {
        status: 200,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'cache-control': 'no-store',
          'x-request-id': requestId,
          ...corsHeaders(request, env),
        },
      }),
    };
  }
  const adapter = getProviderAdapter(node.provider).image;
  if (!adapter) {
    rotateWithNeutralEnd(state, node, KIND.CLIENT, c);
    return {
      response: gatewayError(
        request,
        env,
        route,
        502,
        'Image provider adapter is unavailable.',
        requestId,
        undefined,
        undefined,
        'gateway_image_adapter_missing',
      ),
    };
  }
  if (node.provider === 'openai-image') {
    const reported = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(reported) && reported > MAX_STREAMED_IMAGE_BYTES) {
      rotateWithNeutralEnd(state, node, KIND.CLIENT, c);
      return {
        response: gatewayError(
          request,
          env,
          route,
          502,
          'Image response exceeds the maximum stream size.',
          requestId,
          undefined,
          undefined,
          'gateway_image_reply_too_large',
        ),
      };
    }
    recordNodeSuccess(c, node, latencyMs);
    return {
      response: new Response(upstream.body, {
        status: 200,
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'cache-control': 'no-store',
          'x-request-id': requestId,
          ...corsHeaders(request, env),
        },
      }),
    };
  }

  const result = await readBodyTextBounded(upstream, MAX_IMAGE_REPLY_BYTES, c.attemptDeadlineMs);
  if (result.isTruncated) {
    rotateWithNeutralEnd(state, node, KIND.CLIENT, c);
    return {
      response: gatewayError(
        request,
        env,
        route,
        502,
        'Image provider response exceeds the bounded reply limit.',
        requestId,
        undefined,
        undefined,
        'gateway_image_reply_too_large',
      ),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    recordOutcome(state, node, classifyEmptyResponse(), c, { latencyMs, status: upstream.status });
    return {
      response: gatewayError(
        request,
        env,
        route,
        502,
        'Image provider returned invalid JSON.',
        requestId,
        undefined,
        undefined,
        'gateway_image_reply_invalid',
      ),
    };
  }
  const image = adapter.extract(parsed);
  if (!image) {
    recordOutcome(state, node, classifyEmptyResponse(), c, { latencyMs, status: upstream.status });
    return {
      response: gatewayError(
        request,
        env,
        route,
        502,
        'Image provider returned no supported base64 image.',
        requestId,
        undefined,
        undefined,
        'gateway_image_reply_invalid',
      ),
    };
  }
  recordNodeSuccess(c, node, latencyMs);
  return {
    response: jsonResponse(200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: image }] }, env, request, {
      'x-request-id': requestId,
      'cache-control': 'no-store',
    }),
  };
}
