#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Pure offline contract checks: no Gateway, Key or Provider request.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { visionColors } from './live-gateway-vision-fixtures.mjs';
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
// Guard the actual image payloads, not just response shapes: a damaged PNG can
// pass the static checks but fail only when the live test randomly selects it.
assert.equal(visionColors.length, 4);
for (const { name, base64 } of visionColors) {
  const imageBytes = Buffer.from(base64, 'base64');
  assert.equal(imageBytes.toString('base64'), base64, `${name} base64`);
  assert.equal(imageBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${name} PNG signature`);
  assert.equal(imageBytes.readUInt32BE(16), 96, `${name} width`);
  assert.equal(imageBytes.readUInt32BE(20), 96, `${name} height`);
  assert.equal(imageBytes[24], 8, `${name} bit depth`);
  assert.equal(imageBytes[25], 2, `${name} RGB color type`);
  const imageData = [];
  let offset = 8;
  let seenEnd = false;
  while (offset < imageBytes.length) {
    assert.ok(offset + 12 <= imageBytes.length, `${name} truncated chunk header`);
    const length = imageBytes.readUInt32BE(offset);
    const type = imageBytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + length + 12;
    assert.ok(end <= imageBytes.length, `${name} truncated ${type} chunk`);
    if (type === 'IDAT') imageData.push(imageBytes.subarray(offset + 8, offset + 8 + length));
    offset = end;
    if (type === 'IEND') {
      seenEnd = true;
      break;
    }
  }
  assert.equal(seenEnd, true, `${name} must end with IEND`);
  assert.equal(offset, imageBytes.length, `${name} unexpected trailing bytes`);
  assert.ok(imageData.length > 0, `${name} missing image data`);
  assert.equal(inflateSync(Buffer.concat(imageData)).length, 96 * (96 * 3 + 1), `${name} invalid PNG pixel data`);
}

console.log('Live Gateway acceptance response contracts passed offline.');
