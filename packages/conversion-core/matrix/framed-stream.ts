// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Private v4 stream adapter. Not connected to dispatch until the Gateway
// can own first-output admission and settle every raw usage/budget event.
import {
  frameInferenceStream,
  INFERENCE_FRAMED_STREAM_CONTENT_TYPE,
  INFERENCE_FRAMED_STREAM_FORMAT,
} from '../../contracts/inference-stream-frames.ts';
import type { IrProtocol } from '../ir.ts';
import { replyFromNativeObject } from './response.ts';
import { type MatrixStreamBudget, type MatrixStreamHandle, openMatrixStream, synthesizeMatrixStreamFromObject } from './stream.ts';

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

/** Provider ignored stream:true and returned one native JSON object.
 *  Only Inference decodes it, then frames client-facing synthetic SSE with
 *  physical usage in the private control channel (never public output). */
export function buildFramedMatrixObjectFallback(native: Record<string, unknown>, from: IrProtocol, to: IrProtocol, displayModel: string): Response {
  const { reply } = replyFromNativeObject(from, native);
  if (!reply.parts.some((part) => part.type === 'text' && part.text) && !reply.parts.some((part) => part.type === 'tool_call')) {
    throw new Error('no meaningful native output to synthesize');
  }
  const synthetic = synthesizeMatrixStreamFromObject({ ...reply, model: displayModel }, to);
  if (!synthetic.body) throw new Error('cannot synthesize client stream');
  const stream = frameInferenceStream((onUsage) => {
    if (reply.rawUsage !== undefined && reply.rawUsage !== null) onUsage(reply.rawUsage);
    return synthetic.body as ReadableStream<Uint8Array>;
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': INFERENCE_FRAMED_STREAM_CONTENT_TYPE,
      'x-aig-response-format': INFERENCE_FRAMED_STREAM_FORMAT,
    },
  });
}
