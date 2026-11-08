// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Private v4 stream adapter. Not connected to dispatch until the Gateway
// can own first-output admission and settle every raw usage/budget event.
import { INFERENCE_FRAMED_STREAM_CONTENT_TYPE, INFERENCE_FRAMED_STREAM_FORMAT, frameInferenceStream } from '../../../packages/contracts/inference-stream-frames.ts';
import type { IrProtocol } from '../../../packages/conversion-core/ir.ts';
import { openMatrixStream, type MatrixStreamBudget, type MatrixStreamHandle } from './stream.ts';

export function buildFramedMatrixResponse(
  upstreamBody: ReadableStream<Uint8Array> | null | undefined,
  from: IrProtocol,
  to: IrProtocol,
  fallbackId: string,
  options: { model?: string; seedInputTokens?: number; budget?: MatrixStreamBudget } = {},
): Response {
  let handle: MatrixStreamHandle | null = null;
  const stream = frameInferenceStream(
    (onUsage) => {
      handle = openMatrixStream(upstreamBody, from, to, fallbackId, { ...options, onUpstreamUsage: onUsage });
      return handle.clientStream;
    },
    () => handle?.budgetExceeded() ?? null,
  );
  return new Response(stream, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': INFERENCE_FRAMED_STREAM_CONTENT_TYPE,
      'x-aig-response-format': INFERENCE_FRAMED_STREAM_FORMAT,
    },
  });
}
