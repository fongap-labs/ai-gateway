#!/usr/bin/env node
import assert from 'node:assert/strict';
import { hasExplicitReasoningOff, normalizeReasoningDefaults } from '../packages/config-core/reasoning-defaults.ts';

const chat = { model: 'Max', messages: [{ role: 'user', content: 'hello' }] };
const responses = { model: 'Max', input: 'hello' };
const anthropic = { model: 'Max', max_tokens: 128, messages: [{ role: 'user', content: 'hello' }] };

for (const token of ['default', 'auto', 'DEFAULT', ' Auto ']) {
  const chatResult = normalizeReasoningDefaults('openai_chat', { ...chat, reasoning_effort: token });
  assert.deepEqual(chatResult, chat, 'Chat default sentinel must not reach upstream');
  const responsesResult = normalizeReasoningDefaults('openai_responses', { ...responses, reasoning: { effort: token, summary: 'auto' } });
  assert.deepEqual(responsesResult, { ...responses, reasoning: { summary: 'auto' } });
  const anthropicResult = normalizeReasoningDefaults('anthropic_messages', { ...anthropic, output_config: { effort: token } });
  assert.deepEqual(anthropicResult, anthropic);
}
for (const route of ['openai_chat', 'openai_responses', 'anthropic_messages']) {
  const body = route === 'openai_chat' ? chat : route === 'openai_responses' ? responses : anthropic;
  assert.equal(normalizeReasoningDefaults(route, body), body, 'missing parameter must preserve native request bytes');
}
assert.equal(hasExplicitReasoningOff('openai_chat', normalizeReasoningDefaults('openai_chat', { ...chat, reasoning_effort: 'OFF' })), true);
assert.equal(hasExplicitReasoningOff('openai_responses', normalizeReasoningDefaults('openai_responses', { ...responses, reasoning: { effort: 'off' } })), true);
assert.equal(hasExplicitReasoningOff('anthropic_messages', { ...anthropic, thinking: { type: 'disabled' } }), true);
assert.equal(hasExplicitReasoningOff('anthropic_messages', { ...anthropic, thinking: { type: 'adaptive' } }), false);
assert.equal(hasExplicitReasoningOff('openai_chat', chat), false);
assert.deepEqual(normalizeReasoningDefaults('openai_chat', { ...chat, reasoning_effort: 'high' }), { ...chat, reasoning_effort: 'high' });
assert.deepEqual(normalizeReasoningDefaults('openai_responses', { ...responses, reasoning: { effort: 'low' } }), {
  ...responses,
  reasoning: { effort: 'low' },
});
assert.deepEqual(normalizeReasoningDefaults('anthropic_messages', { ...anthropic, thinking: { type: 'disabled' } }), {
  ...anthropic,
  thinking: { type: 'disabled' },
});

console.log('Reasoning client-default and explicit-off contract passed without model capability gating.');
