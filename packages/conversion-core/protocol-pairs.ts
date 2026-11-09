// SPDX-License-Identifier: MIT
// Protocol-pair membership is control-plane metadata, not a converter import.
import type { IrProtocol } from './ir.ts';

const MATRIX_PROTOCOLS: readonly IrProtocol[] = ['openai_chat', 'openai_responses', 'anthropic'];

/** All distinct directed Chat / Responses / Anthropic pairs are supported. */
export function isMatrixPair(from: IrProtocol, to: IrProtocol): boolean {
  return from !== to && MATRIX_PROTOCOLS.includes(from) && MATRIX_PROTOCOLS.includes(to);
}
