// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Internal-only frame decoder. Caller must run Gateway's first-event guard
// over the decoded client SSE and construct fresh public response headers.
import {
  INFERENCE_FRAMED_STREAM_CONTENT_TYPE,
  INFERENCE_FRAMED_STREAM_FORMAT,
  unframeInferenceStream,
} from '../../packages/contracts/inference-stream-frames.ts';
import type { BudgetStopReason } from '../../packages/conversion-core/budget.ts';

export function decodeFramedInferenceResponse(
  response: Response,
  callbacks: { onUsage?: (usage: Record<string, unknown>) => void; onBudgetStop?: (reason: BudgetStopReason) => void } = {},
): ReadableStream<Uint8Array> {
  if (
    !response.ok ||
    !response.body ||
    response.headers.get('x-aig-response-format') !== INFERENCE_FRAMED_STREAM_FORMAT ||
    response.headers.get('content-type') !== INFERENCE_FRAMED_STREAM_CONTENT_TYPE
  ) {
    throw new Error('invalid private inference stream response');
  }
  return unframeInferenceStream(response.body, callbacks);
}
