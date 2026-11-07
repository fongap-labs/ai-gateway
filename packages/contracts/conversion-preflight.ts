// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Private, read-only conversion preflight. No Provider, node or tier dispatch.
import type { ConversionResult } from '../conversion-core/result.ts';
import { MAX_EXECUTION_DEADLINE_AHEAD_MS } from './execution.ts';

export const INFERENCE_PREFLIGHT_PATH = '/internal/conversion/preflight' as const;
export const INFERENCE_PREFLIGHT_VERSION = '1' as const;

export type InferencePreflightInvocation = { requestId: string; deadlineMs: number };
export type ConversionPreflightApproval = Pick<ConversionResult, 'fidelity' | 'diagnostics' | 'structuredOutput'> & { ok: true };
export type ConversionPreflightRejection = { ok: false; code: 'conversion_not_supported'; requestField?: string };
export type ConversionPreflightResult = ConversionPreflightApproval | ConversionPreflightRejection;

export function buildInferencePreflightHeaders(invocation: InferencePreflightInvocation, key: string): Headers {
  return new Headers({
    'content-type': 'application/json',
    'x-aig-inference-auth': key,
    'x-aig-preflight-version': INFERENCE_PREFLIGHT_VERSION,
    'x-aig-request-id': invocation.requestId,
    'x-aig-deadline-ms': String(invocation.deadlineMs),
  });
}

export function parseInferencePreflightInvocation(request: Request, nowMs = Date.now()): InferencePreflightInvocation | null {
  if (request.headers.get('x-aig-preflight-version') !== INFERENCE_PREFLIGHT_VERSION) return null;
  const requestId = request.headers.get('x-aig-request-id') ?? '';
  const deadlineRaw = request.headers.get('x-aig-deadline-ms') ?? '';
  if (!/^[a-f0-9-]{36}$/i.test(requestId) || !/^\d{13}$/.test(deadlineRaw)) return null;
  const deadlineMs = Number(deadlineRaw);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= nowMs || deadlineMs > nowMs + MAX_EXECUTION_DEADLINE_AHEAD_MS) return null;
  return { requestId, deadlineMs };
}

export function isConversionPreflightResult(value: unknown): value is ConversionPreflightResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (data.ok === false) {
    return (
      data.code === 'conversion_not_supported' &&
      (data.requestField === undefined || (typeof data.requestField === 'string' && data.requestField.length <= 64))
    );
  }
  if (data.ok !== true || !['exact', 'portable', 'degraded'].includes(String(data.fidelity)) || !Array.isArray(data.diagnostics)) return false;
  if (
    data.diagnostics.length > 256 ||
    !data.diagnostics.every(
      (d: unknown) =>
        d !== null &&
        typeof d === 'object' &&
        !Array.isArray(d) &&
        typeof (d as { feature?: unknown }).feature === 'string' &&
        (d as { feature: string }).feature.length <= 128 &&
        ['mapped', 'dropped', 'emulated', 'defaulted'].includes(String((d as { action?: unknown }).action)),
    )
  )
    return false;
  if (data.structuredOutput === undefined) return true;
  const output = data.structuredOutput;
  return (
    !!output &&
    typeof output === 'object' &&
    !Array.isArray(output) &&
    ['native', 'tool', 'prompt'].includes(String((output as { strategy?: unknown }).strategy))
  );
}
