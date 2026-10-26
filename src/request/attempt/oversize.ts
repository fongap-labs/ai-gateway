// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// oversize.ts - terminal outcome for an upstream reply larger than the gateway
// buffers. Rotating would only regenerate the same oversized answer elsewhere.

import { classifyOversizedReply } from '../../reliability/classify.ts';
import type { RuntimeNode } from '../../types/node.ts';
import type { AttemptContext, AttemptOutcome } from '../../types/request.ts';
import { UPSTREAM_PROCESSING_ERROR, upstreamProcessingErrorCode } from '../../types/upstream-processing.ts';
import { gatewayError } from '../errors.ts';
import { recordOutcome } from './outcome.ts';

export function isOversizedReplyError(error: unknown): boolean {
  return upstreamProcessingErrorCode(error) === UPSTREAM_PROCESSING_ERROR.TOO_LARGE;
}

export function stopOnOversizedReply(c: AttemptContext, node: RuntimeNode, latencyMs: number, status: number): AttemptOutcome {
  recordOutcome(c.state, node, classifyOversizedReply(), c, {
    latencyMs,
    status,
    diagnostic: 'upstream reply exceeded the gateway buffered-response limit',
  });
  return {
    response: gatewayError(
      c.request,
      c.env,
      c.route,
      502,
      'Upstream reply is larger than the gateway can buffer. Retry with stream:true.',
      c.requestId,
      undefined,
      undefined,
      'upstream_reply_too_large',
    ),
  };
}
