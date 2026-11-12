// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Shared private-center protocol request conversion. Gateway callers temporarily
// use a compatibility export; this module is the sole conversion implementation.
import type { MatrixDiag } from '../diag.ts';
import type { IrProtocol, IrRequest } from '../ir.ts';
import { isMatrixPair } from '../protocol-pairs.ts';
import type { ConversionResult, StructuredOutputStrategy } from '../result.ts';
import { ConversionError } from '../validation.ts';
import { buildAnthropicRequest, parseAnthropicRequest } from './anthropic.ts';
import { buildChatRequest, parseChatRequest } from './chat.ts';
import { buildResponsesRequest, parseResponsesRequest } from './responses.ts';

export { isMatrixPair } from '../protocol-pairs.ts';

// ---- Request translation ----------------------------------------------------

export function convertMatrixRequest(
  from: IrProtocol,
  to: IrProtocol,
  body: Record<string, unknown>,
  options: { isNonstreamPreferred?: boolean } = {},
): ConversionResult {
  if (!isMatrixPair(from, to)) throw new ConversionError(`conversion_not_supported: pair ${String(from)}->${String(to)} is not matrix-owned`);
  let ir: IrRequest;
  let diag: MatrixDiag;
  switch (from) {
    case 'openai_chat':
      ({ request: ir, diag } = parseChatRequest(body));
      break;
    case 'anthropic':
      ({ request: ir, diag } = parseAnthropicRequest(body));
      break;
    case 'openai_responses':
      ({ request: ir, diag } = parseResponsesRequest(body));
      break;
    default:
      throw new ConversionError(`conversion_not_supported: pair ${String(from)}->${String(to)}`);
  }
  return buildTarget(to, ir, diag, options.isNonstreamPreferred === true);
}

function buildTarget(to: IrProtocol, ir: IrRequest, diag: MatrixDiag, isNonstreamPreferred = false): ConversionResult {
  switch (to) {
    case 'anthropic':
      return finalizeMatrix(diag, buildAnthropicRequest(ir, diag), ir.structuredOutputSchema ? 'prompt' : undefined, isNonstreamPreferred);
    case 'openai_chat':
      return finalizeMatrix(diag, buildChatRequest(ir, diag), ir.structuredOutputSchema ? 'prompt' : undefined, isNonstreamPreferred);
    case 'openai_responses':
      return finalizeMatrix(diag, buildResponsesRequest(ir, diag), ir.structuredOutputSchema ? 'native' : undefined, isNonstreamPreferred);
    default:
      throw new ConversionError(`conversion_not_supported: matrix target "${String(to)}"`);
  }
}

function finalizeMatrix(
  diag: MatrixDiag,
  body: Record<string, unknown>,
  structuredOutput: StructuredOutputStrategy | undefined,
  isNonstreamPreferred = false,
): ConversionResult {
  // Translation matrix paths default to driving the upstream in streaming mode
  // (AIG_CONVERSION_PREFER_NONSTREAM off): non-streaming clients are served
  // from the collected reply through the single decode path. With the flag on,
  // a non-streaming CLIENT keeps its own stream flag so the provider may
  // answer with one JSON body — the success layer already translates and
  // bounds that shape (readBufferedReplyText / replyFromNativeObject), and
  // SSE parsing disappears from the request. Streaming clients upstream-stream.
  if (!isNonstreamPreferred || body.stream === true) body.stream = true;
  return diag.finalize(body, structuredOutput ? { strategy: structuredOutput } : undefined);
}
