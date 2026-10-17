// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Diagnostics accumulator for the translation matrix. Produces exactly the
// ConversionDiagnostic vocabulary defined in ../result.ts and finalizes into
// a ConversionResult. The vocabulary is CLOSED: feature is a free token but
// must never carry request text, tool names, schemas or credentials.

import type { ConversionDiagnostic, ConversionFidelity, ConversionResult, StructuredOutputStrategy } from '../result.ts';

export class MatrixDiag {
  private readonly items: ConversionDiagnostic[] = [];

  get diagnostics(): readonly ConversionDiagnostic[] {
    return this.items;
  }

  add(diagnostic: ConversionDiagnostic): void {
    if (this.items.some((d) => d.feature === diagnostic.feature && d.action === diagnostic.action && d.strategy === diagnostic.strategy)) return;
    this.items.push(diagnostic);
  }

  fidelity(): ConversionFidelity {
    if (this.items.some((d) => d.action === 'dropped' || d.action === 'emulated' || d.action === 'defaulted')) return 'degraded';
    return this.items.length > 0 ? 'portable' : 'exact';
  }

  finalize(body: Record<string, unknown>, structuredOutput?: { strategy: StructuredOutputStrategy }): ConversionResult {
    return { body, fidelity: this.fidelity(), diagnostics: this.items, ...(structuredOutput ? { structuredOutput } : {}) };
  }
}
