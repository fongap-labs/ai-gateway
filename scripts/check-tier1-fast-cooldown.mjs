#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildClientErrorResponse, buildExhaustedResponse } from '../apps/gateway/response/errors.ts';
import { classifyUpstreamStatus } from '../src/reliability/classify.ts';
import {
  __resetTier1StateForTests,
  applyTier1Outcome,
  classifyTier1Failure,
  getTier1Model,
  recordTier1Success,
  TIER1_CIRCUIT_COOLDOWN_FLOOR_MS,
  TIER1_FAILURE_STREAK_WINDOW_MS,
  TIER1_FAST_COOLDOWN_MS,
} from '../src/reliability/tier1-state.ts';

const t = 1_000_000;
const server = classifyTier1Failure({ kind: 'server' });
const timeout = classifyTier1Failure({ kind: 'headers_timeout' });
const delayedServer = classifyUpstreamStatus(503, new Headers({ 'Retry-After': '7' }), {}, t);
const delayedDecision = classifyTier1Failure(delayedServer, { retryAfterMs: delayedServer.retryAfterMs });
assert.equal(delayedDecision.cooldownMs, 7_000, 'Tier 1 must honor upstream 503 Retry-After');
__resetTier1StateForTests();
applyTier1Outcome('free-key-retry', 'Code-Ultra', delayedDecision, t);
assert.equal(getTier1Model('free-key-retry', 'Code-Ultra').cooldownUntil, t + 7_000);
assert.equal(getTier1Model('unrelated-key', 'Code-Ultra').cooldownUntil, 0);
assert.equal(classifyTier1Failure({ kind: 'server' }).cooldownMs, 0, 'missing Retry-After preserves exponential fallback');
__resetTier1StateForTests();

applyTier1Outcome('free-key-1', 'Code-Ultra', server, t);
const model = getTier1Model('free-key-1', 'Code-Ultra');
assert.equal(model.consecutiveFailures, 1);
assert.equal(model.cooldownUntil, 0);
applyTier1Outcome('free-key-1', 'Code-Ultra', timeout, t + 1);
assert.equal(model.consecutiveFailures, 2);
assert.equal(model.failureState, 'cooldown');
assert.ok(model.cooldownUntil >= t + 1 + TIER1_FAST_COOLDOWN_MS);
assert.equal(getTier1Model('free-key-1', 'General-Ultra').cooldownUntil, 0);
assert.equal(getTier1Model('free-key-2', 'Code-Ultra').cooldownUntil, 0);
const firstDeadline = model.cooldownUntil;
applyTier1Outcome('free-key-1', 'Code-Ultra', server, t + 2);
assert.equal(model.failureState, 'cooldown');
assert.equal(model.consecutiveFailures, 3);
assert.ok(model.cooldownUntil > firstDeadline);
assert.ok(model.cooldownUntil >= t + 2 + TIER1_CIRCUIT_COOLDOWN_FLOOR_MS);
recordTier1Success('free-key-1', 'Code-Ultra', model.cooldownUntil + 1);
assert.equal(model.consecutiveFailures, 0);
assert.equal(model.lastCountedFailureAt, 0);

__resetTier1StateForTests();
applyTier1Outcome('free-key-1', 'Code-Ultra', server, t);
applyTier1Outcome('free-key-1', 'Code-Ultra', timeout, t + TIER1_FAILURE_STREAK_WINDOW_MS + 1);
assert.equal(getTier1Model('free-key-1', 'Code-Ultra').consecutiveFailures, 1);
assert.equal(getTier1Model('free-key-1', 'Code-Ultra').cooldownUntil, 0);

__resetTier1StateForTests();
const recovering = getTier1Model('free-key-1', 'Code-Ultra');
recovering.failureState = 'half_open';
applyTier1Outcome('free-key-1', 'Code-Ultra', classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'model' }, { retryAfterMs: 15_000 }), t);
assert.equal(recovering.cooldownUntil, t + 15_000);
assert.equal(recovering.failureState, 'cooldown');

const contextTooLong = classifyUpstreamStatus(
  400,
  new Headers(),
  {},
  t,
  '{"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}',
);
assert.equal(contextTooLong.action, 'rotate', 'context overflow can recover on a different Provider or model');
assert.equal(contextTooLong.requestTooLarge, true);
assert.equal(contextTooLong.providerModelConstraint, true, 'same Provider and physical model should not be repeated in a single request');
assert.equal(classifyUpstreamStatus(400, new Headers(), {}, t, '{"error":{"message":"invalid json"}}').action, 'stop');
assert.equal(classifyUpstreamStatus(400, new Headers(), {}, t, 'opaque request rejected').providerModelConstraint, undefined);

const opaqueGone = classifyUpstreamStatus(410, new Headers(), {}, t, 'HTTP 410');
assert.equal(opaqueGone.action, 'rotate');
assert.equal(opaqueGone.physicalRouteFailure, true, 'ambiguous 410 avoids the same physical route without disabling an entire account');
assert.equal(opaqueGone.cooldownMs, 0);
const mappedGone = classifyUpstreamStatus(410, new Headers(), {}, t, '{"error":{"code":"model_not_found","message":"model removed"}}');
assert.equal(mappedGone.kind, 'model_missing');
assert.equal(mappedGone.modelScoped, true);
assert.equal(mappedGone.cooldownMs, 1_800_000);

const rejected = classifyUpstreamStatus(422, new Headers(), {}, t, 'unprocessable');
assert.equal(rejected.action, 'rotate', 'opaque 422 permits a bounded alternate physical route');
assert.equal(rejected.uncertain422, true, 'opaque upstream 422 must remain distinguishable from malformed client payloads');
assert.equal(rejected.counted, false);
const invalidRequest = classifyUpstreamStatus(422, new Headers(), {}, t, '{"error":{"code":"invalid_json"}}');
assert.equal(invalidRequest.action, 'stop', 'explicit invalid request must not be replayed');
applyTier1Outcome('free-key-1', 'Code-Ultra', classifyTier1Failure(rejected), t + TIER1_FAILURE_STREAK_WINDOW_MS + 2);
assert.equal(getTier1Model('free-key-1', 'Code-Ultra').consecutiveFailures, 0);

const response = buildClientErrorResponse(
  new Request('https://gateway.example/v1/chat/completions'),
  {},
  'openai_chat',
  'offline-request-id',
  'Code-Ultra',
  422,
  'private upstream details',
  { logicalAttempts: 4, dispatches: 4, hedges: 0, failureKinds: { server: 2, headers_timeout: 1, client: 1 }, attempts: [] },
  false,
);
assert.equal(response.status, 422);
const raw = await response.text();
const error = JSON.parse(raw).error;
assert.match(error.message, /^422 \| /, 'client error must be status-first');
assert.equal(error.details?.attempts, undefined, 'client body must not expose internal dispatch details');
assert.equal(response.headers.get('x-gateway-attempts'), '4');
assert.equal(response.headers.get('x-gateway-failure-kinds'), 'client:1,headers_timeout:1,server:2');
assert.ok(!raw.includes('private upstream details'));
const exhaustionRequest = new Request('https://gateway.example/v1/chat/completions', { method: 'POST' });
const exhaustionDescriptor = { model: 'Code-Max', route: 'openai_chat', protocol: 'openai', surface: 'chat_completions', bodyChars: 300 };
const exhaustionTiers = { 'tier-1': [], 'tier-2': [] };
const mixedState = {
  requestedModel: 'Code-Max',
  logicalAttempts: 8,
  dispatches: 8,
  hedges: 0,
  failureKinds: { client: 1, rate_limit: 3, headers_timeout: 4 },
  attempts: [
    { dispatched: true, kind: 'client', status: 422, effective_model: 'Code-Max' },
    ...Array.from({ length: 3 }, () => ({ dispatched: true, kind: 'rate_limit', status: 429, effective_model: 'Code-Max' })),
    ...Array.from({ length: 4 }, () => ({ dispatched: true, kind: 'headers_timeout', status: 0, effective_model: 'Code-Max' })),
  ],
  logger: { info() {} },
};
const mixedResponse = buildExhaustedResponse(
  exhaustionRequest,
  {},
  'openai_chat',
  'offline-mixed-exhaustion',
  'Code-Max',
  mixedState,
  exhaustionTiers,
  false,
  exhaustionDescriptor,
  new Set(['Code-Max']),
  true,
);
assert.equal(mixedResponse.status, 503, 'route-local 422 must not mask transient family exhaustion');
assert.equal(JSON.parse(await mixedResponse.text()).error.details.retryable, true);
const malformedMixed = { ...mixedState, attempts: [{ ...mixedState.attempts[0], status: 400 }, ...mixedState.attempts.slice(1)] };
const invalidMixedResponse = buildExhaustedResponse(
  exhaustionRequest,
  {},
  'openai_chat',
  'offline-invalid-exhaustion',
  'Code-Max',
  malformedMixed,
  exhaustionTiers,
  false,
  exhaustionDescriptor,
  new Set(['Code-Max']),
  true,
);
assert.equal(invalidMixedResponse.status, 504, 'malformed client request must not be recast as transient');
assert.equal(JSON.parse(await invalidMixedResponse.text()).error.details.retryable, false);
__resetTier1StateForTests();
console.log('Tier 1 Key+model cooldown and scoped 422 diagnostics passed offline.');
