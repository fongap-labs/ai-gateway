import type { ConversionResult } from './result.ts';

const HIGH_RISK_DROPPED_FEATURES = new Set([
  'provider_native_tool',
  'provider_native_tool_history',
  'response_continuation',
  'responses_prompt_reference',
  'responses_truncation_policy',
  'thinking_history',
  'local_shell_history',
  'custom_tool_definition',
  'custom_tool_history',
  'unknown_input_item',
]);

export function highRiskSemanticLoss(result: Pick<ConversionResult, 'diagnostics'>): string[] {
  return result.diagnostics.filter((d) => d.action === 'dropped' && HIGH_RISK_DROPPED_FEATURES.has(d.feature)).map((d) => d.feature);
}
