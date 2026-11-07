// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Shared fail-closed semantic fidelity policy for Gateway admission and
// Inference execution. Do not maintain duplicate high-risk lists.
import type { ConversionResult } from './result.ts';

const HIGH_RISK_DROPPED_FEATURES = new Set(['provider_native_tool', 'provider_native_tool_history']);

export function highRiskSemanticLoss(result: Pick<ConversionResult, 'diagnostics'>): string[] {
  return result.diagnostics.filter((d) => d.action === 'dropped' && HIGH_RISK_DROPPED_FEATURES.has(d.feature)).map((d) => d.feature);
}
