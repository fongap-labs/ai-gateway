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
