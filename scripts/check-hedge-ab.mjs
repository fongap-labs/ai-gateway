#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Deterministic Hedge on/off comparison against an in-process fake center.
// This is NOT a live Provider benchmark and makes no network/Token requests.

import assert from 'node:assert/strict';
import { handleRequest } from '../apps/gateway/request-handler.ts';
import { getPoliciesConfigDiagnostics } from '../src/config/policies.ts';

const model = 'Code-Max';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runScenario(enabled) {
  const label = enabled ? 'hedge-on' : 'hedge-off';
  const dispatches = [];
  const datasetEvents = [];
  const env = {
    AIG_ACCESS_KEY_AIR: 'offline-hedge-access-key',
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_INFERENCE_AUTH_KEY: 'i'.repeat(32),
    AIG_TIER1_NODES_01: JSON.stringify(
      ['one', 'two'].map((suffix) => ({
        id: `${label}-${suffix}`,
        provider: 'openai',
        base_url: 'https://provider.example.invalid/v1',
        models: { [model]: 'physical-code-max' },
      })),
    ),
    AIG_MODELS_CONFIG: JSON.stringify({ [model]: { policy: 'default' } }),
    AIG_POLICIES_CONFIG: JSON.stringify({
      default: { max_attempts: 1, tier_attempts: { tier1: 1 }, hedge: { enabled, delay_ms: 20, tiers: ['tier1'] } },
    }),
    GATEWAY_EVENTS: {
      writeDataPoint(event) {
        datasetEvents.push(event);
      },
    },
    AIG_INFERENCE_SERVICE: {
      async fetch(request) {
        const first = dispatches.length === 0;
        dispatches.push(request.headers.get('x-aig-node-id'));
        // Whichever free Key is picked first is slow; the alternate is fast.
        // This is a controlled tail-latency comparison, not a quota policy.
        await pause(first ? 250 : 5);
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-hedge',
            object: 'chat.completion',
            created: 1,
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' } },
        );
      },
    },
  };
  assert.deepEqual(getPoliciesConfigDiagnostics(env), []);
  const request = new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer offline-hedge-access-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'offline comparison' }] }),
  });
  const start = Date.now();
  const response = await handleRequest(request, env, { waitUntil() {}, passThroughOnException() {} });
  const elapsedMs = Date.now() - start;
  assert.equal(response.status, 200, `${label} must return a usable response`);
  assert.equal((await response.json()).choices?.[0]?.message?.content, 'ok');
  // Account for a cancelled slow loser that is still settling asynchronously.
  await pause(265);
  return { elapsedMs, dispatches, events: datasetEvents };
}

const off = await runScenario(false);
const on = await runScenario(true);
assert.equal(off.dispatches.length, 1, 'hedge disabled must never duplicate a Provider dispatch');
assert.equal(on.dispatches.length, 2, 'hedge opt-in must dispatch exactly one distinct free twin');
assert.notEqual(on.dispatches[0], on.dispatches[1], 'twin must use a different free Key');
assert.ok(on.dispatches.length <= 2, 'hedge must obey maxAttempts=1 plus maxHedges=1 physical cap');
console.log(
  `Offline Hedge A/B: disabled=${off.dispatches.length} dispatch / ${off.elapsedMs}ms, enabled=${on.dispatches.length} dispatches / ${on.elapsedMs}ms. No real Provider calls.`,
);
