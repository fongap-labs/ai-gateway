#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Native object reply conversion and compatibility identity contracts.
import assert from 'node:assert/strict';
import {
  replyToAnthropicObject as ownerAnthropic,
  replyToChatObject as ownerChat,
  replyFromNativeObject as ownerFrom,
  replyToObject as ownerRender,
  replyToResponsesObject as ownerResponses,
} from '../apps/inference/conversion/response.ts';
import {
  replyToAnthropicObject as compatAnthropic,
  replyToChatObject as compatChat,
  replyFromNativeObject as compatFrom,
  replyToObject as compatRender,
  replyToResponsesObject as compatResponses,
} from '../src/conversion/matrix/pipeline.ts';

assert.strictEqual(compatFrom, ownerFrom);
assert.strictEqual(compatAnthropic, ownerAnthropic);
assert.strictEqual(compatChat, ownerChat);
assert.strictEqual(compatRender, ownerRender);
assert.strictEqual(compatResponses, ownerResponses);

const reply = {
  id: 'object-test',
  model: 'test-model',
  stop: 'end',
  parts: [{ type: 'text', text: 'hello' }],
  inputTokens: 3,
  rawUsage: { input_tokens: 3, output_tokens: 2 },
};
const chat = ownerRender(reply, 'openai_chat');
assert.equal(chat.choices[0].message.content, 'hello');
const anthropic = ownerRender(reply, 'anthropic');
assert.equal(anthropic.content[0].text, 'hello');
assert.equal(anthropic.usage.input_tokens, 3);
const responses = ownerRender(reply, 'openai_responses');
assert.equal(responses.output[0].content[0].text, 'hello');
assert.equal(responses.usage.total_tokens, 5);
assert.throws(() => ownerRender(reply, 'unsupported'), /conversion_not_supported/);
console.log('Inference-owned native-object renderers preserved three protocol shapes, usage and export identity.');
