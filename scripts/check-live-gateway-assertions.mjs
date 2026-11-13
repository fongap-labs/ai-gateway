#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Pure offline contract checks: no Gateway, Key or Provider request.
import assert from 'node:assert/strict';
import { hasChatVisionColor, hasGeneratedImageDataUri, hasResponsesOutputText, hasResponsesVisionColor } from './live-gateway-assertions.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGN8JiLCwMDAxMDAwMDAAAANpAESe7q5qgAAAABJRU5ErkJggg==';
for (const mime of ['png', 'jpeg', 'webp', 'gif']) {
  assert.equal(hasGeneratedImageDataUri({ choices: [{ message: { content: `![Generated image](data:image/${mime};base64,${png})` } }] }), true, mime);
}
for (const content of [
  '![Generated image](data:image/svg+xml;base64,AAAA)',
  '![Generated image](data:image/png;base64,AAAA)',
  '![Generated image](https://example.invalid/image.png)',
  '![Generated image](data:image/jpeg;base64,)',
  '![Generated image](data:image/png;base64,INVALID%%%BASE64)',
  'Generated text, not an image.',
  '',
]) {
  assert.equal(hasGeneratedImageDataUri({ choices: [{ message: { content } }] }), false, content);
}
assert.equal(hasGeneratedImageDataUri({ choices: [] }), false);

const response = {
  object: 'response',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A square is shown.' }] }],
};
assert.equal(hasResponsesOutputText(response), true);
assert.equal(hasResponsesOutputText({ ...response, output: [{ type: 'message', role: 'assistant', content: [] }] }), false);
assert.equal(hasResponsesOutputText({ output: [{ type: 'function_call', arguments: '{}' }] }), false);
assert.equal(hasResponsesOutputText({ output: [{ type: 'message', role: 'user', content: [{ type: 'output_text', text: 'text' }] }] }), false);
assert.equal(hasResponsesOutputText({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '   ' }] }] }), false);
assert.equal(hasResponsesOutputText({ error: { message: 'upstream unavailable' } }), false);
const chatVision = (answer) => ({ choices: [{ message: { content: answer } }] });
assert.equal(hasChatVisionColor(chatVision('RED.'), 'red'), true);
assert.equal(hasChatVisionColor(chatVision('blue'), 'red'), false);
assert.equal(hasChatVisionColor(chatVision('I cannot see the image.'), 'red'), false);
assert.equal(hasChatVisionColor(chatVision('red and blue'), 'red'), false);
assert.equal(hasChatVisionColor(chatVision('red'), 'purple'), false);
assert.equal(hasChatVisionColor({ choices: [] }, 'red'), false);

const responsesVision = (answer, role = 'assistant') => ({
  output: [{ type: 'message', role, content: [{ type: 'output_text', text: answer }] }],
});
assert.equal(hasResponsesVisionColor(responsesVision('yellow'), 'yellow'), true);
assert.equal(hasResponsesVisionColor(responsesVision('green'), 'yellow'), false);
assert.equal(hasResponsesVisionColor(responsesVision('Sorry, no image is available'), 'yellow'), false);
assert.equal(hasResponsesVisionColor(responsesVision('yellow', 'user'), 'yellow'), false);
assert.equal(hasResponsesVisionColor({ output: [{ type: 'function_call', arguments: 'yellow' }] }, 'yellow'), false);
console.log('Live Gateway acceptance response contracts passed offline.');
