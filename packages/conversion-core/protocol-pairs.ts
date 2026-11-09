// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Public, metadata-only pair eligibility; no request body conversion, Provider
// adapter, or Inference Center implementation belongs in this module.
import type { IrProtocol } from './ir.ts';

const MATRIX_PROTOCOLS: readonly IrProtocol[] = ['openai_chat', 'openai_responses', 'anthropic'];

export function isMatrixPair(from: IrProtocol, to: IrProtocol): boolean {
  return from !== to && MATRIX_PROTOCOLS.includes(from) && MATRIX_PROTOCOLS.includes(to);
}
