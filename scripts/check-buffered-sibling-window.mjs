#!/usr/bin/env node
import assert from 'node:assert/strict';
import { preferUntriedFailureProviders } from '../apps/gateway/reliability/retry-budget.ts';
import { handleRequest } from '../apps/gateway/request-handler.ts';
import { attemptBudgetWindowMs, requestSizeAllowanceMs, viableFailoverWindowMs } from '../src/config/timeouts.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';

const source = 'Code-Ultra';
const fallback = 'Code-Max';
const key = 'offline-buffered-hop-test-key';

async function exercise(hasSibling, promptChars = 0) {
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
  const requestBody = JSON.stringify({
    model: source,
    messages: [{ role: 'user', content: promptChars > 0 ? 'x'.repeat(promptChars) : 'Do the task' }],
  });
  const request = new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: requestBody,
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
    const expectedHopMs = 45_000 + requestSizeAllowanceMs(requestBody.length);
    assert.ok(calls[0].remainingMs <= expectedHopMs, 'the first model must honor the prompt-aware sibling-hop cap');
    assert.ok(calls[0].remainingMs > expectedHopMs - 2_000, 'prompt allowance must reach the first model before abort');
    assert.ok(calls[1].remainingMs > 45_000, 'the fallback may use the remaining request window');
  } else {
    assert.equal(calls.length, 1);
    assert.ok(calls[0].remainingMs > 45_000, 'without a sibling, buffered inference must retain its full waiting window');
  }
}

await exercise(true);
await exercise(false);
await exercise(true, 120_000);
assert.equal(viableFailoverWindowMs(1_000), 0, 'small requests retain the existing failover policy');
assert.equal(attemptBudgetWindowMs(60_000, 8, viableFailoverWindowMs(1_000)), 25_000);
const largeBodyChars = 1_900_000;
const viableMs = viableFailoverWindowMs(largeBodyChars);
assert.ok(viableMs >= 25_000, 'large requests need a viable second chance');
assert.equal(attemptBudgetWindowMs(120_000, 8, viableMs), 120_000 - viableMs, 'reserve one feasible retry rather than seven 5s windows');
assert.equal(attemptBudgetWindowMs(27_000, 8, viableMs), 27_000, 'when only one viable window remains, do not split it into doomed short hops');
assert.equal(attemptBudgetWindowMs(27_000, 1, viableMs), 27_000);

const providerNodes = [
  { id: 'slow-a', tier: 'tier-1', provider: 'nvidia' },
  { id: 'slow-b', tier: 'tier-1', provider: 'nvidia' },
  { id: 'independent', tier: 'tier-1', provider: 'openrouter' },
];
const providerFailure = [{ dispatched: true, node_id: 'slow-a', kind: 'headers_timeout', status: 504 }];
const preferred = preferUntriedFailureProviders(providerNodes, providerNodes, providerFailure, new Set(['slow-a']));
assert.equal(preferred?.has('slow-b'), true, 'prefer an independent Provider after NVIDIA timeout');
assert.equal(preferred?.has('independent'), false, 'the healthy alternate remains dispatchable');
assert.equal(preferUntriedFailureProviders(providerNodes.slice(0, 2), providerNodes, providerFailure, new Set(['slow-a'])), null);
assert.equal(preferUntriedFailureProviders(providerNodes, providerNodes, [{ ...providerFailure[0], kind: 'client', status: 400 }], new Set()), null);

console.log('Buffered sibling hop caps and single-model full-window contracts passed offline.');
