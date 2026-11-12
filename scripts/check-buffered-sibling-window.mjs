#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Buffered model fallback must preserve a sibling's waiting budget.

import assert from 'node:assert/strict';
import { handleRequest } from '../apps/gateway/request-handler.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';

const source = 'Code-Ultra';
const fallback = 'Code-Max';
const key = 'offline-buffered-hop-test-key';

async function exercise(hasSibling) {
  __resetAllStateForTests();
  __resetTier1StateForTests();
  __resetTier1AffinityForTests();
  const calls = [];
  const nodes = [
    {
      id: 'source-key',
      provider: 'openai',
      base_url: 'https://provider.example.invalid/v1',
      models: { [source]: 'upstream-source' },
    },
    ...(hasSibling
      ? [
          {
            id: 'fallback-key',
            provider: 'openai',
            base_url: 'https://provider.example.invalid/v1',
            models: { [fallback]: 'upstream-fallback' },
          },
        ]
      : []),
  ];
  const env = {
    AIG_ACCESS_KEY_ULTRA: key,
    AIG_ACCESS_MODELS_ULTRA: '*',
    AIG_TIER1_NODES_01: JSON.stringify(nodes),
    AIG_INFERENCE_AUTH_KEY: 'i'.repeat(32),
    AIG_FAILOVER_BUDGET_MS: '180000',
    AIG_MODELS_CONFIG: JSON.stringify({
      [source]: { policy: 'default', ...(hasSibling ? { fallback: [fallback] } : {}) },
      [fallback]: { policy: 'default' },
    }),
    AIG_POLICIES_CONFIG: JSON.stringify({
      default: { max_attempts: 2, tier_attempts: { tier1: 2 }, hedge: { enabled: false } },
    }),
    AIG_INFERENCE_SERVICE: {
      async fetch(request) {
        const body = await request.json();
        const deadlineMs = Number(request.headers.get('x-aig-deadline-ms'));
        assert.equal(body.model, request.headers.get('x-aig-model'));
        assert.ok(Number.isSafeInteger(deadlineMs));
        calls.push({ model: body.model, remainingMs: deadlineMs - Date.now() });
        if (hasSibling && body.model === source) {
          return new Response(JSON.stringify({ error: { message: 'temporary upstream failure' } }), {
            status: 503,
            headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' },
          });
        }
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-buffered-fallback',
            object: 'chat.completion',
            created: 1,
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' } },
        );
      },
    },
  };
  const request = new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: source, messages: [{ role: 'user', content: 'Do the task' }] }),
  });

  const response = await handleRequest(request, env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200, await response.text());
  assert.ok(calls[0]?.remainingMs > 0, 'the first candidate must have a real deadline');
  if (hasSibling) {
    assert.deepEqual(
      calls.map((call) => call.model),
      [source, fallback],
      'a failed buffered source must leave a viable compatible-model fallback',
    );
    assert.ok(calls[0].remainingMs <= 45_000, 'the first model must honor the existing 45s sibling-hop cap');
    assert.ok(calls[1].remainingMs > 45_000, 'the fallback may use the remaining request window');
  } else {
    assert.equal(calls.length, 1);
    assert.ok(calls[0].remainingMs > 45_000, 'without a sibling, buffered inference must retain its full waiting window');
  }
}

await exercise(true);
await exercise(false);
console.log('Buffered sibling hop caps and single-model full-window contracts passed offline.');
