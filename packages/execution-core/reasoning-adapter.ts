import type { ExecutionSurface } from '../contracts/execution.ts';
import type { ReasoningPreference } from '../contracts/reasoning-preference.ts';
import type { NodeReasoning } from '../contracts/runtime-node.ts';

export type AdaptedReasoning = {
  body: Record<string, unknown>;
  changed: boolean;
  applied: 'native' | 'off' | 'effort' | 'budget' | 'adaptive';
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stripControls(body: Record<string, unknown>): Record<string, unknown> {
  const result = { ...body };
  delete result.reasoning_effort;
  delete result.thinking;
  delete result.reasoning;
  const output = object(result.output_config);
  if (output && Object.hasOwn(output, 'effort')) {
    const next = { ...output };
    delete next.effort;
    if (Object.keys(next).length) result.output_config = next;
    else delete result.output_config;
  }
  return result;
}

function bestLevel(target: ReasoningPreference, supported: ReadonlyArray<string> | undefined): string | null {
  if (target === 'off') return null;
  const levels = supported ?? [];
  const order = ['low', 'medium', 'high', 'max'];
  const position = order.indexOf(target);
  for (let index = position; index >= 0; index--) {
    if (levels.includes(order[index] ?? '')) return order[index] ?? null;
  }
  return levels.includes('low') ? 'low' : null;
}

export function adaptNodeReasoning(
  body: Record<string, unknown>,
  surface: ExecutionSurface,
  preference: ReasoningPreference | undefined,
  config: NodeReasoning | undefined,
): AdaptedReasoning {
  if (!config || !preference || surface === 'images_generations') return { body, changed: false, applied: 'native' };
  const without = stripControls(body);
  if (config.mode === 'none' || preference === 'off') {
    if (preference === 'off' && surface === 'messages' && config.mode !== 'none') {
      return { body: { ...without, thinking: { type: 'disabled' } }, changed: true, applied: 'off' };
    }
    return { body: without, changed: true, applied: 'off' };
  }
  if (config.mode === 'effort') {
    const level = bestLevel(preference, config.efforts);
    if (!level) return { body, changed: false, applied: 'native' };
    if (surface === 'chat_completions') return { body: { ...without, reasoning_effort: level }, changed: true, applied: 'effort' };
    if (surface === 'responses') return { body: { ...without, reasoning: { effort: level } }, changed: true, applied: 'effort' };
    if (surface === 'messages')
      return { body: { ...without, output_config: { ...(object(without.output_config) ?? {}), effort: level } }, changed: true, applied: 'effort' };
  }
  if (config.mode === 'adaptive' && surface === 'messages') {
    const level = bestLevel(preference, config.efforts);
    return {
      body: {
        ...without,
        thinking: { type: 'adaptive' },
        ...(level ? { output_config: { ...(object(without.output_config) ?? {}), effort: level } } : {}),
      },
      changed: true,
      applied: 'adaptive',
    };
  }
  if (config.mode === 'budget' && surface === 'messages') {
    const maxTokens = body.max_tokens;
    if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) return { body, changed: false, applied: 'native' };
    const headroom = 1024;
    const available = Math.floor(maxTokens) - headroom;
    if (available < 1024) return { body, changed: false, applied: 'native' };
    const highBudget = config.highBudgetTokens;
    if (!highBudget) return { body, changed: false, applied: 'native' };
    const factor = preference === 'low' ? 0.35 : preference === 'medium' ? 0.65 : preference === 'max' ? 1 : 1;
    const budget = Math.min(available, Math.floor(highBudget * factor));
    if (budget < 1024) return { body, changed: false, applied: 'native' };
    return {
      body: { ...without, thinking: { type: 'enabled', budget_tokens: budget } },
      changed: true,
      applied: 'budget',
    };
  }
  return { body, changed: false, applied: 'native' };
}
