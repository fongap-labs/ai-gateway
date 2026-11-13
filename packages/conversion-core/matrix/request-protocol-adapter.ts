// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Pure request-protocol boundary used by private inference execution.
// No Provider calls, Key selection, model capability guesses or retries.
import type { ExecutionInputSurface, ExecutionSurface } from '../../contracts/execution.ts';
import { highRiskSemanticLoss } from '../fidelity-policy.ts';
import { protocolForSurface } from '../surface-protocol.ts';
import { ConversionError } from '../validation.ts';
import { convertMatrixRequest, isMatrixPair } from './request.ts';

export type PreparedProtocolRequest =
  | { ok: true; body: Record<string, unknown>; converted: boolean }
  | { ok: false; status: 400 | 422; code: 'center_conversion_route_invalid' | 'center_conversion_invalid' | 'center_conversion_semantic_loss' };

/** Preserve the input object when no conversion is requested. */
export function prepareProtocolRequest(
  body: Record<string, unknown>,
  inputSurface: ExecutionInputSurface | undefined,
  targetSurface: ExecutionSurface,
  isNonstreamPreferred: boolean = false,
): PreparedProtocolRequest {
  if (!inputSurface) return { ok: true, body, converted: false };
  const from = protocolForSurface(inputSurface);
  const to = protocolForSurface(targetSurface);
  if (!from || !to || !isMatrixPair(from, to)) {
    return { ok: false, status: 400, code: 'center_conversion_route_invalid' };
  }
  try {
    const converted = convertMatrixRequest(from, to, body, { isNonstreamPreferred: isNonstreamPreferred });
    if (highRiskSemanticLoss(converted).length > 0) {
      return { ok: false, status: 422, code: 'center_conversion_semantic_loss' };
    }
    return { ok: true, body: converted.body, converted: true };
  } catch (error) {
    if (error instanceof ConversionError) return { ok: false, status: 400, code: 'center_conversion_invalid' };
    throw error;
  }
}
