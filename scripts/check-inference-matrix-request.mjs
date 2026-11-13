#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The single request-conversion implementation handles every directed pair.
import assert from 'node:assert/strict';
import { buildAnthropicRequest, parseAnthropicRequest } from '../apps/inference/conversion/anthropic.ts';
import { highRiskSemanticLoss } from '../packages/conversion-core/fidelity-policy.ts';
import { convertMatrixRequest as ownedConvert, isMatrixPair as ownedPair } from '../apps/inference/conversion/request.ts';
import { convertMatrixRequest as legacyConvert, isMatrixPair as legacyPair } from '../src/conversion/matrix/pipeline.ts';

assert.strictEqual(ownedConvert, legacyConvert, 'compatibility conversion must not be a second implementation');
assert.strictEqual(ownedPair, legacyPair, 'protocol pair semantics must share one function');

const protocols = ['openai_chat', 'openai_responses', 'anthropic'];
for (const from of protocols) {
  for (const to of protocols) {
    assert.equal(ownedPair(from, to), from !== to, `incorrect matrix pair: ${from}->${to}`);
  }
}
assert.equal(ownedPair('unsupported', 'openai_chat'), false);

const chat = { model: 'test-model', stream: false, messages: [{ role: 'user', content: 'hello' }] };
const anthropic = { model: 'test-model', max_tokens: 128, stream: false, messages: [{ role: 'user', content: 'hello' }] };
const responses = { model: 'test-model', input: 'hello', stream: false };
for (const [from, body] of [
  ['openai_chat', chat],
  ['anthropic', anthropic],
  ['openai_responses', responses],
]) {
  for (const to of protocols) {
    if (to === from) continue;
    const converted = ownedConvert(from, to, body);
    assert.ok(converted.body, `missing converted body for ${from}->${to}`);
    assert.equal(converted.body.stream, true, `default upstream streaming changed for ${from}->${to}`);
    assert.ok(Array.isArray(converted.diagnostics));
  }
}
const preferred = ownedConvert('openai_chat', 'anthropic', chat, { isNonstreamPreferred: true });
assert.notEqual(preferred.body.stream, true, 'explicit nonstream preference must be honored');
assert.throws(() => ownedConvert('openai_chat', 'openai_chat', chat), /conversion_not_supported/);
assert.throws(() => ownedConvert('openai_chat', 'anthropic', { ...chat, unexpected: true }), /conversion_not_supported/);
// Encrypted Responses reasoning must never become Anthropic redacted_thinking.
const encryptedResponses = ownedConvert('openai_responses', 'anthropic', {
  model: 'test-model',
  input: [
    { type: 'reasoning', encrypted_content: 'responses-only-ciphertext' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  ],
});
assert.doesNotMatch(JSON.stringify(encryptedResponses.body), /responses-only-ciphertext|redacted_thinking/);
assert.ok(encryptedResponses.diagnostics.some((d) => d.feature === 'thinking_history' && d.action === 'dropped'));
assert.deepEqual(highRiskSemanticLoss(encryptedResponses), ['thinking_history']);
for (const [body, expected] of [
  [{ model: 'test-model', previous_response_id: 'resp-previous', input: 'next' }, 'response_continuation'],
  [{ model: 'test-model', prompt: { id: 'prompt-reference' }, input: 'next' }, 'responses_prompt_reference'],
  [{ model: 'test-model', truncation: 'auto', input: 'next' }, 'responses_truncation_policy'],
  [{ model: 'test-model', input: [{ type: 'local_shell_call', action: { command: 'echo hello' } }] }, 'local_shell_history'],
  [
    { model: 'test-model', input: 'next', tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }] },
    'custom_tool_definition',
  ],
]) {
  const result = ownedConvert('openai_responses', 'openai_chat', body);
  assert.ok(highRiskSemanticLoss(result).includes(expected), `must not silently lose ${expected} across protocols`);
}
const regularResponses = ownedConvert('openai_responses', 'openai_chat', responses);
assert.deepEqual(highRiskSemanticLoss(regularResponses), [], 'ordinary portable Responses requests remain convertible');

// PDF documents, including tool-result attachments, must survive Anthropic rendering.
const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK' } };
const docRequest = parseAnthropicRequest({
  model: 'test-model',
  max_tokens: 128,
  messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_pdf', name: 'read_pdf', input: {} }] },
    { role: 'user', content: [pdf, { type: 'tool_result', tool_use_id: 'call_pdf', content: [pdf] }] },
  ],
});
const rebuilt = buildAnthropicRequest(docRequest.request, docRequest.diag);
const userBlocks = rebuilt.messages[rebuilt.messages.length - 1].content;
assert.equal(userBlocks.find((block) => block.type === 'document').source.media_type, 'application/pdf');
assert.equal(userBlocks.find((block) => block.type === 'tool_result').content.find((block) => block.type === 'document').source.data, 'JVBERi0xLjQK');
assert.throws(
  () =>
    buildAnthropicRequest(
      { ...docRequest.request, messages: [{ role: 'user', parts: [{ type: 'document', mediaType: 'text/plain', data: 'YQ==' }] }] },
      docRequest.diag,
    ),
  /base64 PDF/,
  'unsupported documents must fail before upstream dispatch',
);
assert.throws(
  () =>
    buildAnthropicRequest(
      {
        ...docRequest.request,
        messages: [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'call_bad', name: 'read_pdf', args: '{broken' }] }],
      },
      docRequest.diag,
    ),
  /tool arguments must be a JSON object/,
  'malformed tool history must not be rewritten into a fake valid call',
);
console.log(
  'Single request Matrix implementation passed all six protocol pairs, PDF attachments, opaque reasoning isolation and fail-closed semantics.',
);
