export type ReasoningPreference = 'off' | 'low' | 'medium' | 'high' | 'max';

const DEFAULT_MARKERS = new Set(['default', 'auto']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalized(value: unknown): ReasoningPreference | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.trim().toLowerCase()) {
    case 'none':
    case 'off':
    case 'disabled':
      return 'off';
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'xhigh':
    case 'max':
      return 'max';
    case 'high':
      return 'high';
    default:
      return undefined;
  }
}

export function requestReasoningPreference(body: Record<string, unknown>): ReasoningPreference {
  const thinking = record(body.thinking);
  if (thinking?.type === 'disabled') return 'off';
  const config = record(body.output_config);
  const reasoning = record(body.reasoning);
  const entries = [body.reasoning_effort, reasoning?.effort, config?.effort];
  for (const entry of entries) {
    const preference = normalized(entry);
    if (preference) return preference;
  }
  if (thinking?.type === 'enabled') return 'high';
  return 'high';
}

export function stripReasoningDefaultMarkers(body: Record<string, unknown>): Record<string, unknown> {
  let result = body;
  if (typeof body.reasoning_effort === 'string' && DEFAULT_MARKERS.has(body.reasoning_effort.trim().toLowerCase())) {
    const { reasoning_effort: _ignored, ...rest } = result;
    result = rest;
  }
  for (const field of ['reasoning', 'output_config'] as const) {
    const entry = record(result[field]);
    if (!entry || typeof entry.effort !== 'string' || !DEFAULT_MARKERS.has(entry.effort.trim().toLowerCase())) continue;
    const { effort: _ignored, ...remaining } = entry;
    if (Object.keys(remaining).length === 0) {
      const { [field]: _ignoredField, ...rest } = result;
      result = rest;
    } else {
      result = { ...result, [field]: remaining };
    }
  }
  return result;
}
