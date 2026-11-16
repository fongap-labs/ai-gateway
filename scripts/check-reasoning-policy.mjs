#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildExecutionHeaders, parseExecutionInvocation } from '../packages/contracts/execution.ts';
import { requestReasoningPreference, stripReasoningDefaultMarkers } from '../packages/contracts/reasoning-preference.ts';
import { adaptNodeReasoning } from '../packages/execution-core/reasoning-adapter.ts';

const chat = { model: 'Max', stream: false, messages: [{ role: 'user', content: 'test' }] };
assert.equal(requestReasoningPreference(chat), 'high');
assert.equal(requestReasoningPreference({ ...chat, reasoning_effort: 'none' }), 'off');
assert.equal(requestReasoningPreference({ ...chat, reasoning_effort: 'low' }), 'low');
assert.equal(requestReasoningPreference({ ...chat, reasoning: { effort: 'medium' } }), 'medium');
assert.equal(requestReasoningPreference({ ...chat, thinking: { type: 'disabled' } }), 'off');
assert.equal(requestReasoningPreference({ ...chat, output_config: { effort: 'xhigh' } }), 'max');
assert.equal(stripReasoningDefaultMarkers(chat), chat);
assert.deepEqual(stripReasoningDefaultMarkers({ ...chat, reasoning_effort: 'default' }), chat);
assert.deepEqual(stripReasoningDefaultMarkers({ ...chat, reasoning: { effort: 'auto' } }), chat);
assert.deepEqual(stripReasoningDefaultMarkers({ ...chat, output_config: { effort: 'default', format: { type: 'json_schema' } } }), {
  ...chat,
  output_config: { format: { type: 'json_schema' } },
});
assert.deepEqual(stripReasoningDefaultMarkers({ ...chat, reasoning_effort: 'none' }).reasoning_effort, 'none');

const unchanged = adaptNodeReasoning(chat, 'chat_completions', 'high', undefined);
assert.equal(unchanged.body, chat, 'unknown nodes preserve native requests');
assert.equal(unchanged.changed, false);
const effort = { mode: 'effort', efforts: ['low', 'medium', 'high'] };
const high = adaptNodeReasoning(chat, 'chat_completions', 'high', effort);
assert.equal(high.body.reasoning_effort, 'high');
assert.equal(high.body.max_tokens, undefined);
const limited = adaptNodeReasoning(chat, 'chat_completions', 'high', { mode: 'effort', efforts: ['low'] });
assert.equal(limited.body.reasoning_effort, 'low');
const explicitOff = adaptNodeReasoning({ ...chat, reasoning_effort: 'high' }, 'chat_completions', 'off', effort);
assert.equal(explicitOff.body.reasoning_effort, undefined);
const none = adaptNodeReasoning({ ...chat, reasoning_effort: 'high' }, 'chat_completions', 'high', { mode: 'none' });
assert.equal(none.body.reasoning_effort, undefined);
const responses = adaptNodeReasoning({ model: 'Max', input: 'test' }, 'responses', 'high', effort);
assert.deepEqual(responses.body.reasoning, { effort: 'high' });
const adaptive = adaptNodeReasoning({ ...chat, max_tokens: 256 }, 'messages', 'high', { mode: 'adaptive', efforts: ['high'] });
assert.deepEqual(adaptive.body.thinking, { type: 'adaptive' });
assert.equal(adaptive.body.max_tokens, 256, 'adaptive reasoning must never inflate the output budget');
assert.deepEqual(adaptive.body.output_config, { effort: 'high' });
const budget = adaptNodeReasoning({ ...chat, max_tokens: 4096 }, 'messages', 'high', { mode: 'budget', highBudgetTokens: 10000 });
assert.equal(budget.body.thinking.budget_tokens, 3072);
assert.equal(budget.body.max_tokens, 4096, 'high reasoning must respect user output limit');
const shortBudget = adaptNodeReasoning({ ...chat, max_tokens: 800 }, 'messages', 'high', { mode: 'budget', highBudgetTokens: 10000 });
assert.equal(shortBudget.changed, false, 'small output budgets do not force 24k thinking tokens');
const disabled = adaptNodeReasoning({ ...chat, thinking: { type: 'enabled', budget_tokens: 3000 } }, 'messages', 'off', { mode: 'adaptive' });
assert.deepEqual(disabled.body.thinking, { type: 'disabled' });

const now = Date.now();
const invocation = {
  requestId: '12345678-1234-4234-8234-123456789012',
  nodeId: 'test-node',
  logicalModel: 'Max',
  surface: 'chat_completions',
  deadlineMs: now + 20000,
  reasoningPreference: 'high',
};
const headers = buildExecutionHeaders(invocation, 'x-aig-inference-auth', 'a'.repeat(40));
const req = new Request('https://inference.internal/internal/execute', { method: 'POST', headers });
assert.deepEqual(parseExecutionInvocation(req, new Set(['chat_completions']), now), invocation);
const invalid = new Headers(headers);
invalid.set('x-aig-reasoning-preference', 'hight');
assert.equal(parseExecutionInvocation(new Request(req, { headers: invalid }), new Set(['chat_completions']), now), null);
console.log('Reasoning defaults, node-specific elastic adaptation, budget caps, off and private contract: passed.');
