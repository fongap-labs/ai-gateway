#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Pure unit tests for the Google Code Assist subscription wire conversion
// (src/subscription/google-wire.ts): request envelope building, non-streaming
// object conversion, and streaming SSE conversion. These exercise the
// converter in isolation; the end-to-end dispatch path is covered by
// tests/oauth-subscription-test.mjs.

import assert from 'node:assert/strict';
import {
  codeAssistObjectToOpenAIChat,
  createOpenAIChatStreamFromCodeAssist,
  GEMINI_CLI_USER_AGENT,
  GEMINI_CODE_ASSIST_ENDPOINT,
  openAIChatToCodeAssistEnvelope,
} from '../src/subscription/google-wire.ts';

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`FAIL: ${name}`);
      console.error(e?.stack || e);
      process.exitCode = 1;
    });
}

function envelope(body) {
  return openAIChatToCodeAssistEnvelope(body);
}

function sse(...events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

async function readStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

// ---- Request envelope -------------------------------------------------------

await test('basic chat builds contents + model + no system', () => {
  const r = envelope({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(r);
  assert.equal(r.envelope.model, 'gemini-2.5-pro');
  assert.deepEqual(r.envelope.request.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  assert.equal(r.envelope.request.systemInstruction, undefined);
  assert.equal(r.streaming, false);
});

await test('system + developer messages collect into systemInstruction', () => {
  const r = envelope({
    model: 'm',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
      { role: 'developer', content: [{ type: 'text', text: 'extra' }] },
    ],
  });
  assert.deepEqual(r.envelope.request.systemInstruction, { parts: [{ text: 'be brief' }, { text: 'extra' }] });
});

await test('assistant tool_calls map to functionCall parts and register id->name', () => {
  const r = envelope({
    model: 'm',
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"sf"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp": 60}' },
    ],
  });
  const contents = r.envelope.request.contents;
  assert.equal(contents[1].role, 'model');
  assert.deepEqual(contents[1].parts, [{ functionCall: { name: 'get_weather', args: { city: 'sf' } } }]);
  assert.equal(contents[2].role, 'user');
  assert.equal(contents[2].parts[0].functionResponse.name, 'get_weather');
  assert.deepEqual(contents[2].parts[0].functionResponse.response, { temp: 60 });
});

await test('tool response with non-JSON content is wrapped as {output}', () => {
  const r = envelope({
    model: 'm',
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'plain text result' },
    ],
  });
  assert.deepEqual(r.envelope.request.contents[2].parts[0].functionResponse.response, { output: 'plain text result' });
});

await test('tools + tool_choice map to functionDeclarations and toolConfig', () => {
  const r = envelope({
    model: 'm',
    messages: [{ role: 'user', content: 'use a tool' }],
    tools: [{ type: 'function', function: { name: 'search', description: 'd', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'search' } },
  });
  assert.deepEqual(r.envelope.request.tools, [{ functionDeclarations: [{ name: 'search', description: 'd', parameters: { type: 'object' } }] }]);
  assert.deepEqual(r.envelope.request.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search'] } });
});

await test('generation config maps OpenAI fields to Gemini names', () => {
  const r = envelope({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    temperature: 0.7,
    top_p: 0.9,
    stop: ['x', 'y'],
    seed: 42,
    response_format: { type: 'json_object' },
  });
  assert.deepEqual(r.envelope.request.generationConfig, {
    maxOutputTokens: 128,
    temperature: 0.7,
    topP: 0.9,
    stopSequences: ['x', 'y'],
    seed: 42,
    responseMimeType: 'application/json',
  });
});

await test('stream flag selects streaming endpoint semantics', () => {
  assert.equal(envelope({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }).streaming, true);
  assert.equal(envelope({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }).streaming, false);
});

await test('image data-url part becomes inlineData', () => {
  const r = envelope({
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
        ],
      },
    ],
  });
  assert.deepEqual(r.envelope.request.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } });
});

await test('refusal: no messages -> null', () => {
  assert.equal(envelope({ model: 'm' }), null);
});

await test('refusal: unsupported user part type -> null', () => {
  assert.equal(envelope({ model: 'm', messages: [{ role: 'user', content: [{ type: 'audio', audio: 'x' }] }] }), null);
});

await test('refusal: tool message without preceding tool_call id -> null', () => {
  assert.equal(envelope({ model: 'm', messages: [{ role: 'tool', tool_call_id: 'ghost', content: '{}' }] }), null);
});

await test('refusal: malformed tool_call arguments -> null', () => {
  assert.equal(
    envelope({
      model: 'm',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{bad json' } }] },
      ],
    }),
    null,
  );
});

await test('refusal: non-function tool type -> null', () => {
  assert.equal(
    envelope({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'web_search', web_search: {} }],
    }),
    null,
  );
});

// ---- Non-streaming object conversion ---------------------------------------

await test('object: text response maps to chat completion + usage', () => {
  const data = {
    candidates: [{ content: { parts: [{ text: 'Hello there' }], role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8, cachedContentTokenCount: 1 },
    modelVersion: 'gemini-2.5-pro',
  };
  const out = codeAssistObjectToOpenAIChat(data);
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.choices[0].message.content, 'Hello there');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8, prompt_tokens_details: { cached_tokens: 1 } });
  assert.equal(out.model, 'gemini-2.5-pro');
});

await test('object: function call maps to tool_calls', () => {
  const out = codeAssistObjectToOpenAIChat({
    candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'sf' } } }], role: 'model' }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
  });
  assert.equal(out.choices[0].message.content, null);
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'get_weather');
  assert.equal(out.choices[0].message.tool_calls[0].function.arguments, '{"city":"sf"}');
  assert.equal(out.choices[0].message.tool_calls[0].type, 'function');
});

await test('object: MAX_TOKENS -> length, SAFETY -> content_filter', () => {
  assert.equal(
    codeAssistObjectToOpenAIChat({ candidates: [{ content: { parts: [{ text: 'cut' }], role: 'model' }, finishReason: 'MAX_TOKENS' }] }).choices[0]
      .finish_reason,
    'length',
  );
  assert.equal(
    codeAssistObjectToOpenAIChat({ candidates: [{ content: { parts: [{ text: 'blocked' }], role: 'model' }, finishReason: 'SAFETY' }] }).choices[0]
      .finish_reason,
    'content_filter',
  );
});

await test('object: no candidates / no meaningful output -> null', () => {
  assert.equal(codeAssistObjectToOpenAIChat({ candidates: [] }), null);
  assert.equal(codeAssistObjectToOpenAIChat({ candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP' }] }), null);
  assert.equal(codeAssistObjectToOpenAIChat('not an object'), null);
});

// ---- Streaming conversion ---------------------------------------------------

await test('stream: text deltas + finish + usage + [DONE]', async () => {
  const input = new Response(
    sse(
      { candidates: [{ content: { parts: [{ text: 'Hel' }], role: 'model' }, index: 0 }] },
      {
        candidates: [{ content: { parts: [{ text: 'lo' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      },
    ),
  ).body;
  const out = await readStream(createOpenAIChatStreamFromCodeAssist(input, { messageId: 'm', model: 'gemini-2.5-pro' }));
  const chunks = out
    .split('\n\n')
    .filter(Boolean)
    .map((c) => c.replace(/^data: /, ''));
  assert.ok(chunks[0].includes('"delta":{"role":"assistant"}'), 'role header first');
  assert.ok(
    chunks.some((c) => c.includes('"delta":{"content":"Hel"}')),
    'first text delta',
  );
  assert.ok(
    chunks.some((c) => c.includes('"delta":{"content":"lo"}')),
    'second text delta',
  );
  assert.ok(
    chunks.some((c) => c.includes('"finish_reason":"stop"')),
    'finish chunk',
  );
  assert.ok(
    chunks.some((c) => c.includes('"usage"') && c.includes('"total_tokens":3')),
    'usage chunk',
  );
  assert.equal(chunks[chunks.length - 1], '[DONE]', '[DONE] terminal');
});

await test('stream: function call delta carries id/name/arguments', async () => {
  const input = new Response(
    sse({
      candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'sf' } } }], role: 'model' }, finishReason: 'STOP' }],
    }),
  ).body;
  const out = await readStream(createOpenAIChatStreamFromCodeAssist(input, { messageId: 'm', model: 'm' }));
  const toolChunk = out
    .split('\n\n')
    .map((c) => c.replace(/^data: /, ''))
    .find((c) => c.includes('tool_calls'));
  assert.ok(toolChunk, 'tool_call delta present');
  const parsed = JSON.parse(toolChunk);
  assert.equal(parsed.choices[0].delta.tool_calls[0].function.name, 'get_weather');
  assert.equal(parsed.choices[0].delta.tool_calls[0].function.arguments, '{"city":"sf"}');
  assert.equal(parsed.choices[0].delta.tool_calls[0].type, 'function');
});

await test('stream: clean upstream end finalizes even without finishReason', async () => {
  const input = new Response(sse({ candidates: [{ content: { parts: [{ text: 'partial' }], role: 'model' } }] })).body;
  const out = await readStream(createOpenAIChatStreamFromCodeAssist(input, { messageId: 'm', model: 'm' }));
  assert.ok(out.includes('"finish_reason":"stop"'), 'defaults to stop on close');
  assert.ok(out.endsWith('data: [DONE]\n\n'), '[DONE] emitted on clean close');
});

await test('stream: no-text response ends with finish stop and [DONE] (guard-safe empty)', async () => {
  const input = new Response(sse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] })).body;
  const out = await readStream(createOpenAIChatStreamFromCodeAssist(input, { messageId: 'm', model: 'm' }));
  assert.ok(out.includes('"finish_reason":"content_filter"'));
  assert.ok(out.endsWith('data: [DONE]\n\n'));
});

await test('constants expose the built-in endpoint and CLI user agent', () => {
  assert.equal(GEMINI_CODE_ASSIST_ENDPOINT, 'https://cloudcode-pa.googleapis.com');
  assert.ok(GEMINI_CLI_USER_AGENT.startsWith('GeminiCLI/'));
});

console.log(`\nGoogle subscription wire tests: ${passed} passed, ${failed} failed.`);
