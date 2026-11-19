#!/usr/bin/env node
import assert from 'node:assert/strict';
import { handleRequest } from '../apps/gateway/request-handler.ts';
import { __resetTier1StateForTests, getTier1Account, getTier1Model } from '../src/reliability/tier1-state.ts';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const model = 'Hedge-Cancel-Test';
const encoder = new TextEncoder();
let slowNodeId = null;
let fastNodeId = null;
let slowCancelledAt = null;
let fastReturnedAt = null;
let cancelResolve;
const slowCancelled = new Promise((resolve) => {
  cancelResolve = resolve;
});
const dispatchedNodeIds = [];
const attemptEvents = [];

__resetTier1StateForTests();
const env = {
  AIG_ACCESS_KEY_AIR: 'offline-hedge-cancel-access-key',
  AIG_ACCESS_MODELS_AIR: '*',
  AIG_FIRST_EVENT_TIMEOUT_MS: '1000',
  AIG_INFERENCE_AUTH_KEY: 'i'.repeat(32),
  AIG_TIER1_NODES_01: JSON.stringify(
    ['one', 'two'].map((suffix) => ({
      id: `hedge-cancel-${suffix}`,
      provider: 'openai',
      base_url: 'https://provider.example.invalid/v1',
      models: { [model]: 'physical-hedge-cancel' },
    })),
  ),
  AIG_MODELS_CONFIG: JSON.stringify({ [model]: { policy: 'default' } }),
  AIG_POLICIES_CONFIG: JSON.stringify({
    default: { max_attempts: 1, tier_attempts: { tier1: 1 }, hedge: { enabled: true, delay_ms: 20, tiers: ['tier1'] } },
  }),
  GATEWAY_EVENTS: { writeDataPoint: (event) => attemptEvents.push(event) },
  AIG_INFERENCE_SERVICE: {
    async fetch(request) {
      const nodeId = request.headers.get('x-aig-node-id');
      dispatchedNodeIds.push(nodeId);
      if (dispatchedNodeIds.length === 1) {
        slowNodeId = nodeId;
        return new Response(
          new ReadableStream({
            cancel() {
              slowCancelledAt = Date.now();
              cancelResolve(slowCancelledAt);
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream', 'x-aig-result': 'dispatched' } },
        );
      }
      fastNodeId = nodeId;
      await pause(50);
      fastReturnedAt = Date.now();
      const event = `data: ${JSON.stringify({
        id: 'chatcmpl-hedge-cancel',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      })}\n\ndata: [DONE]\n\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(event));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream', 'x-aig-result': 'dispatched' } },
      );
    },
  },
};

const request = new Request('https://gateway.example.invalid/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${env.AIG_ACCESS_KEY_AIR}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'offline slow hedge branch' }] }),
});
const response = await handleRequest(request, env, { waitUntil() {}, passThroughOnException() {} });
assert.equal(response.status, 200, 'the healthy hedge stream must win');
assert.ok(slowNodeId && fastNodeId && slowNodeId !== fastNodeId, 'the hedge must use a distinct node');
assert.equal((await response.text()).includes('ok'), true, 'the winning stream remains available to the client');

const cancelAt = await Promise.race([slowCancelled, pause(100).then(() => null)]);
assert.notEqual(cancelAt, null, 'the losing reader must be cancelled promptly');
assert.ok(cancelAt - fastReturnedAt <= 50, `losing reader cancellation took ${cancelAt - fastReturnedAt}ms`);
assert.equal(dispatchedNodeIds.length, 2, 'a request without a preinitialized attemptDeadlineMs must still hedge');
assert.equal(getTier1Account(slowNodeId).inFlight, 0, 'the losing node Tier 1 slot is released');
assert.equal(getTier1Account(fastNodeId).inFlight, 0, 'the winning stream Tier 1 slot is released after completion');
const slowModel = getTier1Model(slowNodeId, model);
assert.equal(slowModel.failureState, 'normal', 'a hedge loser must not enter failure cooldown');
assert.equal(slowModel.cooldownUntil, 0, 'a hedge loser must not acquire a cooldown');
assert.equal(
  attemptEvents.filter((event) => event.blobs?.[4] === 'first_event_timeout').length,
  0,
  'hedge cancellation is not a first-event timeout',
);
console.log(
  `Offline hedge stream cancellation: loser=${slowNodeId}, winner=${fastNodeId}, cancellation=${cancelAt - fastReturnedAt}ms; no provider network calls.`,
);
