// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Runtime-neutral, fail-closed budget ticket for inference-stream v5.
// The caller's own configuration is already clamped; these ceilings are an
// additional trust boundary, never a source of default budget values.
import type { MatrixConversionBudget } from '../conversion-core/budget.ts';

export type InferenceStreamBudget = {
  mode: 'error' | 'truncate';
  cfg: MatrixConversionBudget;
};

const BOUNDS: Record<keyof MatrixConversionBudget, number> = {
  maxEvents: 2_000_000,
  maxOutputUnits: 64_000_000,
  maxToolEvents: 1_000_000,
  maxToolArgUnits: 8_000_000,
  maxOutputTokens: 10_000_000,
};
export const MAX_INFERENCE_STREAM_BUDGET_HEADER = 512;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseInferenceStreamBudget(raw: string | null): InferenceStreamBudget | null {
  if (!raw || raw.length > MAX_INFERENCE_STREAM_BUDGET_HEADER) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed) || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'mode') || !Object.hasOwn(parsed, 'cfg')) return null;
  if (parsed.mode !== 'error' && parsed.mode !== 'truncate') return null;
  if (!isPlainRecord(parsed.cfg) || Object.keys(parsed.cfg).length !== 5) return null;
  const cfg = parsed.cfg;
  for (const key of Object.keys(BOUNDS) as Array<keyof MatrixConversionBudget>) {
    const value = cfg[key];
    if (!Number.isSafeInteger(value) || (value as number) < (key === 'maxOutputTokens' ? 0 : 1) || (value as number) > BOUNDS[key]) return null;
  }
  return { mode: parsed.mode, cfg: cfg as MatrixConversionBudget };
}

export function serializeInferenceStreamBudget(budget: InferenceStreamBudget): string {
  const serialized = JSON.stringify(budget);
  if (!parseInferenceStreamBudget(serialized)) throw new Error('invalid private inference stream budget');
  return serialized;
}
