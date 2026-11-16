import { classifyOversizedReply } from '../../../src/reliability/classify.ts';
import { recordOutcome } from '../../../src/request/attempt/outcome.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';
import type { AttemptContext, AttemptOutcome } from '../../../src/types/request.ts';
import { UPSTREAM_PROCESSING_ERROR, upstreamProcessingErrorCode } from '../../../src/types/upstream-processing.ts';
import { gatewayError } from '../response/errors.ts';

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
