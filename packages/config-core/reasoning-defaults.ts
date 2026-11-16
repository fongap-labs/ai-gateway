type ReasoningRoute = 'openai_chat' | 'openai_responses' | 'anthropic_messages' | string;

function normalizedEffort(value: unknown): 'default' | 'off' | 'unchanged' {
  if (typeof value !== 'string') return 'unchanged';
  const token = value.trim().toLowerCase();
  if (token === 'default' || token === 'auto') return 'default';
  if (token === 'off') return 'off';
  return 'unchanged';
}

export function normalizeReasoningDefaults(route: ReasoningRoute, body: Record<string, unknown>): Record<string, unknown> {
  if (route === 'openai_chat') {
    const normalized = normalizedEffort(body.reasoning_effort);
    if (normalized === 'default') {
      const { reasoning_effort: _ignored, ...rest } = body;
      return rest;
    }
    if (normalized === 'off') return { ...body, reasoning_effort: 'none' };
    return body;
  }
  if (route === 'openai_responses' || route === 'anthropic_messages') {
    const field = route === 'openai_responses' ? 'reasoning' : 'output_config';
    const record = body[field];
    if (!record || typeof record !== 'object' || Array.isArray(record)) return body;
    const value = record as Record<string, unknown>;
    const normalized = normalizedEffort(value.effort);
    if (normalized === 'default') {
      const { effort: _ignored, ...rest } = value;
      if (Object.keys(rest).length === 0) {
        const { [field]: _ignoredContainer, ...other } = body;
        return other;
      }
      return { ...body, [field]: rest };
    }
    if (normalized === 'off' && route === 'openai_responses') {
      return { ...body, reasoning: { ...value, effort: 'none' } };
    }
  }
  return body;
}

export function hasExplicitReasoningOff(route: ReasoningRoute, body: Record<string, unknown>): boolean {
  if (route === 'openai_chat') return body.reasoning_effort === 'none' || body.reasoning_effort === 'off';
  if (route === 'openai_responses') {
    const value = body.reasoning;
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      ((value as Record<string, unknown>).effort === 'none' || (value as Record<string, unknown>).effort === 'off');
  }
  if (route === 'anthropic_messages') {
    const value = body.thinking;
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      (value as Record<string, unknown>).type === 'disabled';
  }
  return false;
}
