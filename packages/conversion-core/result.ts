// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Conversion result contract shared by every translator. The pairwise
// Chat <-> Messages converter wrappers that used to live here were absorbed
// into the IR matrix (conversion/matrix/): request bodies, fidelity
// diagnostics and structured-output strategies are produced per-protocol now.

export type ConversionFidelity = 'exact' | 'portable' | 'degraded';
export type ConversionDiagnosticAction = 'mapped' | 'dropped' | 'emulated' | 'defaulted';
export type StructuredOutputStrategy = 'native' | 'tool' | 'prompt';

export type ConversionDiagnostic = {
  feature: string;
  action: ConversionDiagnosticAction;
  strategy?: StructuredOutputStrategy;
};

export type ConversionResult = {
  body: Record<string, unknown>;
  fidelity: ConversionFidelity;
  diagnostics: readonly ConversionDiagnostic[];
  structuredOutput?: { strategy: StructuredOutputStrategy };
};
