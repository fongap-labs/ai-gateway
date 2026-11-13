#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Deterministic tests. No external network, Cloudflare account or real keys.

import assert from 'node:assert/strict';
import { handleRequest } from '../apps/gateway/request-handler.ts';
import { handleInferenceCenterRequest } from '../apps/inference/index.ts';
import { createInternalTraceparent, parseTraceparent, traceIdForRequest } from '../packages/contracts/trace-context.ts';
import { loadExecutionConfig, loadGatewayConfig } from '../src/config/nodes.ts';
import { handleGenerationCenterRequest } from '../src/generation/generation-center-entry.ts';
import { buildGenerationRequest, GenerationCenterUnavailable } from '../src/generation/generation-client-request.ts';
import { quotaFromCenter } from '../src/reliability/center-quota.ts';
import { attemptNode } from '../src/request/attempt/dispatch.ts';

const internalKey = 'generation-test-auth-key-at-least-32-chars';
const imageToolPng = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGN8JiLCwMDAxMDAwMDAAAANpAESe7q5qgAAAABJRU5ErkJggg==';
let imageToolData = imageToolPng;
const secret = 'fake-provider-credential-for-test-only';
const node = {
  id: 'test-image-node',
  provider: 'google-image',
  base_url: 'https://example.invalid',
  models: { 'image-test': 'gemini-test-image' },
};
const env = {
  AIG_GENERATION_AUTH_KEY: internalKey,
  AIG_TIER2_NODES_01: JSON.stringify([node]),
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ [node.id]: secret }),
};
const validBody = { model: 'image-test', prompt: 'Draw a square', size: '1024x1024' };
function request(body = validBody, overrides = {}) {
  return new Request('https://generation.internal/internal/execute', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aig-contract-version': '1',
      'x-aig-request-id': '12345678-1234-4234-8234-123456789012',
      'x-aig-node-id': node.id,
      'x-aig-model': 'image-test',
      'x-aig-surface': 'images_generations',
      'x-aig-deadline-ms': String(Date.now() + 90_000),
      'x-aig-generation-auth': internalKey,
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}

const originalFetch = globalThis.fetch;
const internalParent = createInternalTraceparent('12345678-1234-4234-8234-123456789012');
let requests = 0;
try {
  globalThis.fetch = async (url, options) => {
    requests += 1;
    assert.match(String(url), /generateContent$/);
    const headers = new Headers(options.headers);
    assert.equal(headers.get('x-goog-api-key'), secret);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    assert.equal(headers.has('x-aig-generation-auth'), false);
    assert.equal(headers.has('tracestate'), false);
    const providerSpan = parseTraceparent(headers.get('traceparent'));
    assert.equal(providerSpan?.traceId, traceIdForRequest('12345678-1234-4234-8234-123456789012'));
    assert.notEqual(providerSpan?.spanId, parseTraceparent(internalParent)?.spanId);
    const body = JSON.parse(options.body);
    assert.equal(body.contents[0].parts[0].text, 'Draw a square');
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const fake = request();
  const missingAuth = await handleGenerationCenterRequest(fake, { ...env, AIG_GENERATION_AUTH_KEY: undefined });
  assert.equal(missingAuth.status, 403);
  assert.equal(requests, 0);
  const invalidSurface = await handleGenerationCenterRequest(request(validBody, { 'x-aig-surface': 'video_generations' }), env);
  assert.equal(invalidSurface.status, 400);
  assert.equal(requests, 0);
  const invalidNode = await handleGenerationCenterRequest(request(validBody, { 'x-aig-node-id': 'missing' }), env);
  assert.equal(invalidNode.status, 404);
  assert.equal(requests, 0);
  const invalidBody = await handleGenerationCenterRequest(request({ ...validBody, n: 2 }), env);
  assert.equal(invalidBody.status, 400);
  assert.equal(requests, 0);
  const forged = request(validBody, {
    authorization: 'Bearer attacker-token',
    cookie: 'token=attacker',
    'x-api-key': 'attacker',
    traceparent: internalParent,
    tracestate: 'client=private',
  });
  const observedSpans = [];
  const nativeCtx = {
    tracing: {
      enterSpan(name, action) {
        const attrs = {};
        observedSpans.push({ name, attrs });
        return action({
          isTraced: true,
          setAttribute: (key, value) => {
            attrs[key] = value;
          },
        });
      },
    },
  };
  const ok = await handleGenerationCenterRequest(forged, env, nativeCtx);
  assert.equal(ok.status, 200);
  assert.equal(observedSpans.length, 1);
  assert.equal(observedSpans[0].name, 'aig.generation.execute');
  assert.equal(observedSpans[0].attrs['aig.center'], 'generation');
  assert.equal(observedSpans[0].attrs['http.response.status_code'], 200);
  assert.equal(ok.headers.get('x-aig-generation-normalized'), 'true');
  assert.equal(ok.headers.get('x-aig-result'), 'dispatched');
  assert.equal(requests, 1);
  assert.deepEqual((await ok.json()).data, [{ b64_json: 'aGVsbG8=' }]);

  // Unknown outcomes are terminal and never internally retried.
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('simulated transport outage');
  };
  const failed = await handleGenerationCenterRequest(request(), env);
  assert.equal(failed.status, 502);
  assert.equal(failed.headers.get('x-aig-result'), 'attempted');
  assert.equal((await failed.json()).error.code, 'generation_outcome_unknown');
  assert.equal(requests, 2);

  // Gateway forwards only its own internal contract, never caller auth.
  const invocation = {
    request: new Request('https://client.example/v1/images/generations', {
      method: 'POST',
      headers: {
        authorization: 'Bearer client',
        cookie: 'secret=x',
        'x-aig-generation-auth': 'forged',
        traceparent: '00-ffffffffffffffffffffffffffffffff-0123456789abcdef-01',
        tracestate: 'client=secret',
      },
    }),
    requestId: '12345678-1234-4234-8234-123456789012',
    node: { id: node.id },
    logicalModel: 'image-test',
    deadlineMs: Date.now() + 60_000,
    body: JSON.stringify(validBody),
  };
  const binder = { AIG_GENERATION_SERVICE: { fetch: async () => new Response(null, { status: 204 }) }, AIG_GENERATION_AUTH_KEY: internalKey };
  const built = buildGenerationRequest(binder, invocation);
  assert.equal(built.headers.get('x-aig-generation-auth'), internalKey);
  assert.equal(built.headers.has('authorization'), false);
  assert.equal(built.headers.has('cookie'), false);
  assert.equal(parseTraceparent(built.headers.get('traceparent'))?.traceId, traceIdForRequest(invocation.requestId));
  assert.notEqual(built.headers.get('traceparent'), invocation.request.headers.get('traceparent'));
  assert.equal(built.headers.has('tracestate'), false);
  assert.throws(() => buildGenerationRequest({}, invocation), GenerationCenterUnavailable);

  assert.deepEqual(quotaFromCenter(new Headers({ 'x-aig-quota-signal': '{"remainingRequests":3}' }))?.remainingRequests, 3);
  assert.equal(quotaFromCenter(new Headers({ 'x-aig-quota-signal': '{"remainingRequests":-1}' })), null);
  // A missing center must fail before a physical Provider request. This checks
  // the real Gateway dispatch selector, not only the private transport helper.
  const unboundState = {
    attempted: new Set(),
    attempts: [],
    logicalAttempts: 0,
    dispatches: 0,
    failureKinds: {},
    maxAttempts: 2,
    requestId: '12345678-1234-4234-8234-123456789012',
    requestedModel: 'image-test',
    logger: { info: () => {} },
  };
  const unboundAttempt = await attemptNode({
    request: new Request('https://client.example/v1/images/generations', { method: 'POST' }),
    env,
    route: 'openai_images',
    node: { ...node, tier: 'tier-2', protocol: 'openai', surfaces: ['images_generations'] },
    reqDescriptor: { model: 'image-test', protocol: 'openai', surface: 'images_generations' },
    bodyJson: validBody,
    conversionContext: null,
    requestId: unboundState.requestId,
    requestedModel: 'image-test',
    remainingDispatchableAttempts: 1,
    failoverBudgetMs: 60_000,
    requestStartMs: Date.now(),
    state: unboundState,
  });
  assert.equal(unboundAttempt.response?.status, 503);
  assert.equal(unboundAttempt.budgetCharged, false);
  assert.equal(unboundState.logicalAttempts, 0);
  assert.equal(unboundState.dispatches, 0);
  assert.equal(requests, 2, 'missing Generation Center must never call physical Provider');

  // The central image suite config must be accepted identically by the
  // Gateway and private center; production never bypasses invalid config.
  const imageModel = 'Image-Creator';
  const imageEnv = {
    AIG_GENERATION_AUTH_KEY: internalKey,
    AIG_ACCESS_KEY_AGENT: 'backend-agent-test-key',
    AIG_ACCESS_MODELS_AGENT: imageModel,
    AIG_ACCESS_KEY_AIR: 'frontend-air-test-key',
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_TIER1_NODES_01: JSON.stringify([
      { id: 'image-1', provider: 'openai-image', base_url: 'https://api.openai.com', models: { [imageModel]: 'gpt-image-1' } },
    ]),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'image-1': 'upstream-mock-secret' }),
    AIG_MODELS_CONFIG: JSON.stringify({
      [imageModel]: {
        policy: 'default',
        visibility: 'internal',
        ui_visible: false,
        group: 'image',
        modalities: { input: ['text'], output: ['image'] },
      },
    }),
    AIG_REQUEST_ADMISSION: 'false',
  };
  const imageConfig = loadExecutionConfig(imageEnv);
  assert.equal(imageConfig.hasConfigErrors, false, `central image config diagnostics: ${JSON.stringify(imageConfig.diagnostics)}`);
  assert.equal(imageConfig.ready, true, 'center image fixture must have a usable provider node');

  // Image generation is center-only even without a deployment marker. Gateway
  // can route image-only nodes using metadata without retaining Provider keys.
  const imageGatewayEnv = {
    AIG_ACCESS_KEY_AGENT: 'center-image-test-client-key',
    AIG_TIER2_NODES_01: env.AIG_TIER2_NODES_01,
  };
  const imageGatewayConfig = loadGatewayConfig(imageGatewayEnv);
  assert.equal(imageGatewayConfig.ready, true);
  assert.equal(imageGatewayConfig.nodes[0].credential, '');
  assert.equal(loadExecutionConfig(imageGatewayEnv).ready, false, 'private generation center still requires a Provider key');
  const imageGatewayWithSecret = loadGatewayConfig({
    ...imageGatewayEnv,
    AIG_TIER2_CREDENTIALS_01: env.AIG_TIER2_CREDENTIALS_01,
  });
  assert.equal(imageGatewayWithSecret.nodes[0].credential, '', 'Gateway must not retain a center-owned image key');
  assert.equal(loadExecutionConfig(env).nodes[0].credential, secret, 'private Generation Center owns its Provider key');

  // Full client -> Gateway -> private Generation Center -> mocked image
  // Provider contract. This deliberately never calls a real paid API.
  const gatewayImageEnv = { ...imageEnv };
  delete gatewayImageEnv.AIG_TIER1_CREDENTIALS_01;
  let centerCalls = 0;
  let physicalCalls = 0;
  // Preserve non-canonical but valid client JSON when no model rewrite is
  // required. A round-trip through JSON.stringify would strip whitespace.
  const originalGenerationJson = '{\n  "model": "Image-Creator",\n  "prompt": "Draw a square",\n  "size": "1024x1024"\n}';
  let expectedCenterRawBody = originalGenerationJson;
  gatewayImageEnv.AIG_GENERATION_SERVICE = {
    async fetch(centerRequest) {
      centerCalls += 1;
      assert.equal(centerRequest.headers.get('authorization'), null, 'client Authorization must never reach Generation Center');
      assert.equal(centerRequest.headers.get('x-aig-generation-auth'), internalKey);
      assert.equal(centerRequest.headers.get('x-aig-node-id'), 'image-1');
      if (expectedCenterRawBody !== null) {
        assert.equal(await centerRequest.clone().text(), expectedCenterRawBody, 'native generation must preserve valid raw JSON');
      }
      return handleGenerationCenterRequest(centerRequest, imageEnv);
    },
  };
  globalThis.fetch = async (url, options) => {
    physicalCalls += 1;
    assert.equal(String(url), 'https://api.openai.com/v1/images/generations');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer upstream-mock-secret');
    const providerBody = JSON.parse(options.body);
    assert.equal(providerBody.model, 'gpt-image-1');
    assert.equal(providerBody.prompt, 'Draw a square');
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: imageToolData }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const gatewayCtx = { waitUntil() {}, passThroughOnException() {} };
  function gatewayImageRequest(key, path = '/v1/images/generations', body = { model: imageModel, prompt: 'Draw a square', size: '1024x1024' }, rawBody = null) {
    return new Request(`https://gateway.example.invalid${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: rawBody ?? JSON.stringify(body),
    });
  }
  const generated = await handleRequest(
    gatewayImageRequest('backend-agent-test-key', '/v1/images/generations', undefined, originalGenerationJson),
    gatewayImageEnv,
    gatewayCtx,
  );
  expectedCenterRawBody = null;
  const generatedBody = await generated.json();
  assert.equal(generated.status, 200, JSON.stringify(generatedBody));
  assert.deepEqual(generatedBody.data, [{ b64_json: imageToolPng }]);
  assert.equal(centerCalls, 1, 'image tool must reach Generation Center exactly once');
  assert.equal(physicalCalls, 1, 'image generation must invoke its Provider exactly once');

  const untrustedClient = await handleRequest(gatewayImageRequest('frontend-air-test-key'), gatewayImageEnv, gatewayCtx);
  assert.equal(untrustedClient.status, 403, 'normal chat keys cannot silently invoke a paid image tool');
  assert.equal(centerCalls, 1);
  assert.equal(physicalCalls, 1);

  const imageAsChat = await handleRequest(
    gatewayImageRequest('backend-agent-test-key', '/v1/chat/completions', {
      model: imageModel,
      messages: [{ role: 'user', content: 'Draw a square' }],
    }),
    gatewayImageEnv,
    gatewayCtx,
  );
  assert.equal(imageAsChat.status, 400, 'an image-only model cannot be dispatched through the text endpoint');
  assert.equal(physicalCalls, 1);

  const disconnectedGateway = { ...gatewayImageEnv };
  delete disconnectedGateway.AIG_GENERATION_SERVICE;
  const missingCenter = await handleRequest(gatewayImageRequest('backend-agent-test-key'), disconnectedGateway, gatewayCtx);
  assert.equal(missingCenter.status, 503, 'missing private Generation Center must fail without a Provider request');
  assert.equal(physicalCalls, 1);

  // A normal Chat endpoint can explicitly request the same Generation tool.
  // There is no keyword guessing: selection, schema and image alias are
  // intentional, and a non-AGENT caller must never spend image credits.
  const toolEnv = {
    ...gatewayImageEnv,
    AIG_ACCESS_MODELS_AGENT: `Max,${imageModel}`,
    AIG_TIER1_NODES_01: JSON.stringify([
      { id: 'image-1', provider: 'openai-image', base_url: 'https://api.openai.com', models: { [imageModel]: 'gpt-image-1' } },
      { id: 'chat-model', provider: 'openai', base_url: 'https://mock.example/v1', models: { Max: 'upstream-max' } },
    ]),
    AIG_MODELS_CONFIG: JSON.stringify({
      [imageModel]: {
        policy: 'default',
        visibility: 'internal',
        ui_visible: false,
        group: 'image',
        modalities: { input: ['text'], output: ['image'] },
      },
      Max: { policy: 'default', capabilities: { tools: true } },
    }),
  };
  function toolChatBody(extra = {}) {
    return {
      model: 'Max',
      messages: [{ role: 'user', content: 'Draw a square' }],
      tools: [{ type: 'function', function: { name: 'generate_image', parameters: { type: 'object', properties: {} } } }],
      tool_choice: { type: 'function', function: { name: 'generate_image' } },
      metadata: { aig_image_model: imageModel, aig_image_size: '1024x1024' },
      ...extra,
    };
  }
  const chatGenerated = await handleRequest(
    gatewayImageRequest('backend-agent-test-key', '/v1/chat/completions', toolChatBody()),
    toolEnv,
    gatewayCtx,
  );
  assert.equal(chatGenerated.status, 200, await chatGenerated.clone().text());
  assert.equal(chatGenerated.headers.get('x-gateway-image-tool'), 'true');
  const chatOutput = await chatGenerated.json();
  assert.equal(chatOutput.model, 'Max');
  assert.equal(chatOutput.choices[0].message.content, `![Generated image](data:image/png;base64,${imageToolPng})`);
  assert.equal(physicalCalls, 2, 'Chat bridge must generate exactly one image without a text-model dispatch');
  assert.equal(centerCalls, 2);

  const chatStreamed = await handleRequest(
    gatewayImageRequest('backend-agent-test-key', '/v1/chat/completions', toolChatBody({ stream: true })),
    toolEnv,
    gatewayCtx,
  );
  assert.equal(chatStreamed.status, 200);
  assert.match(chatStreamed.headers.get('content-type') || '', /text\/event-stream/);
  const streamedText = await chatStreamed.text();
  assert.match(streamedText, /data: \[DONE\]/);
  assert.match(streamedText, /data:image\/png;base64/);
  assert.equal(physicalCalls, 3);

  const imageToolDenied = await handleRequest(
    gatewayImageRequest('frontend-air-test-key', '/v1/chat/completions', toolChatBody()),
    toolEnv,
    gatewayCtx,
  );
  assert.equal(imageToolDenied.status, 403);
  assert.equal(physicalCalls, 3, 'ordinary chat keys cannot initiate billable image generation');

  const undeclaredTool = await handleRequest(
    gatewayImageRequest('backend-agent-test-key', '/v1/chat/completions', toolChatBody({ tools: [] })),
    toolEnv,
    gatewayCtx,
  );
  assert.equal(undeclaredTool.status, 400);
  assert.equal(physicalCalls, 3);

  const missingImageModel = await handleRequest(
    gatewayImageRequest('backend-agent-test-key', '/v1/chat/completions', toolChatBody({ metadata: {} })),
    toolEnv,
    gatewayCtx,
  );
  assert.equal(missingImageModel.status, 400);
  assert.equal(physicalCalls, 3);

  // The ordinary Chat model may now choose generate_image with tool_choice
  // auto. Only an AGENT key, a declared tool and an authorized image alias
  // allow this two-hop Inference -> Generation sequence.
  const decisionCenterEnv = {
    ...toolEnv,
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'chat-model': 'mock-text-secret', 'image-1': 'upstream-mock-secret' }),
  };
  toolEnv.AIG_INFERENCE_AUTH_KEY = 't'.repeat(32);
  decisionCenterEnv.AIG_INFERENCE_AUTH_KEY = toolEnv.AIG_INFERENCE_AUTH_KEY;
  let decisionCalls = 0;
  let returnOnlyText = false;
  toolEnv.AIG_INFERENCE_SERVICE = {
    async fetch(decisionRequest) {
      decisionCalls += 1;
      assert.equal(decisionRequest.headers.get('x-aig-node-id'), 'chat-model');
      return handleInferenceCenterRequest(decisionRequest, decisionCenterEnv);
    },
  };
  const imageFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.model !== 'upstream-max') return imageFetch(url, options);
    assert.equal(String(url), 'https://mock.example/v1/chat/completions');
    assert.equal(payload.stream, false);
    assert.equal(payload.metadata?.aig_image_model, undefined, 'internal tool metadata must not reach text Provider');
    const reply = returnOnlyText
      ? { role: 'assistant', content: 'No image requested.' }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-image',
              type: 'function',
              function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'Draw a square' }) },
            },
          ],
        };
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-auto-tool',
        object: 'chat.completion',
        created: 1,
        model: 'upstream-max',
        choices: [{ index: 0, message: reply, finish_reason: returnOnlyText ? 'stop' : 'tool_calls' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const autoBody = toolChatBody({ tool_choice: 'auto' });
  const autoGenerated = await handleRequest(gatewayImageRequest('backend-agent-test-key', '/v1/chat/completions', autoBody), toolEnv, gatewayCtx);
  assert.equal(autoGenerated.status, 200, await autoGenerated.clone().text());
  assert.equal(autoGenerated.headers.get('x-gateway-image-tool'), 'true');
  assert.equal((await autoGenerated.json()).choices[0].message.content, `![Generated image](data:image/png;base64,${imageToolPng})`);
  assert.equal(decisionCalls, 1, 'one text model selection before image generation');
  assert.equal(physicalCalls, 4, 'exactly one billable image request after selection');

  const streamedAuto = await handleRequest(
    gatewayImageRequest('backend-agent-test-key', '/v1/chat/completions', toolChatBody({ tool_choice: 'auto', stream: true })),
    toolEnv,
    gatewayCtx,
  );
  assert.equal(streamedAuto.status, 200);
  assert.match(streamedAuto.headers.get('content-type') || '', /text\/event-stream/);
  assert.match(await streamedAuto.text(), /data:image\/png;base64/);
  assert.equal(decisionCalls, 2);
  assert.equal(physicalCalls, 5);

  returnOnlyText = true;
  const autoText = await handleRequest(gatewayImageRequest('backend-agent-test-key', '/v1/chat/completions', autoBody), toolEnv, gatewayCtx);
  assert.equal(autoText.status, 200);
  assert.equal((await autoText.json()).choices[0].message.content, 'No image requested.');
  assert.equal(decisionCalls, 3);
  assert.equal(physicalCalls, 5, 'a model text reply must never generate an image');

  const autoDenied = await handleRequest(gatewayImageRequest('frontend-air-test-key', '/v1/chat/completions', autoBody), toolEnv, gatewayCtx);
  assert.equal(autoDenied.status, 403);
  assert.equal(decisionCalls, 3);
  assert.equal(physicalCalls, 5);
  globalThis.fetch = imageFetch;

  // The Chat image bridge must not label JPEG as PNG or turn non-image
  // Provider data into a broken Markdown attachment. Never replay on error.
  imageToolData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48]).toString(
    'base64',
  );
  const jpegImage = await handleRequest(gatewayImageRequest('backend-agent-test-key', '/v1/chat/completions', toolChatBody()), toolEnv, gatewayCtx);
  assert.equal(jpegImage.status, 200);
  assert.equal((await jpegImage.json()).choices[0].message.content, `![Generated image](data:image/jpeg;base64,${imageToolData})`);
  const beforeInvalidImage = physicalCalls;
  imageToolData = 'aGVsbG8=';
  const invalidImage = await handleRequest(
    gatewayImageRequest('backend-agent-test-key', '/v1/chat/completions', toolChatBody()),
    toolEnv,
    gatewayCtx,
  );
  assert.equal(invalidImage.status, 502, 'non-image base64 must not be sent to client as image/png');
  assert.equal(invalidImage.headers.get('x-gateway-error-code'), 'gateway_image_tool_reply_invalid');
  assert.equal(physicalCalls, beforeInvalidImage + 1, 'an invalid generated image must never be re-generated automatically');
  imageToolData = imageToolPng;

  console.log('Full Gateway -> Generation Center -> mocked Provider, authorization, and zero-retry contracts passed.');
  console.log('Private generation center contracts passed.');
} finally {
  globalThis.fetch = originalFetch;
}
