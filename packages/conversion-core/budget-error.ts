// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Identical client-protocol budget error framing in local Gateway conversion
// and private Inference conversion; this module has no public transport role.
import type { IrProtocol } from './ir.ts';

const encoder = new TextEncoder();

export function conversionBudgetErrorChunk(protocol: IrProtocol, requestId: string): Uint8Array {
  const message = 'Gateway conversion output budget exceeded.';
  const code = 'conversion_budget_exceeded';
  if (protocol === 'openai_responses') {
    return encoder.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', code, message, param: null, sequence_number: 0 })}\n\n`);
  }
  if (protocol === 'anthropic') {
    return encoder.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`);
  }
  return encoder.encode(`data: ${JSON.stringify({ error: { message, type: 'api_error', code } })}\n\ndata: [DONE]\n\n`);
}
