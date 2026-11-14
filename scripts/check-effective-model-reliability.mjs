#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Offline model-family attribution regression. No Provider, secrets, KV or D1.

import assert from 'node:assert/strict';
import { recordNodeSuccess, recordTier1NonStreamTtft } from '../apps/gateway/attempt/observability.ts';
import { recordOutcome, rotateWithNeutralEnd } from '../apps/gateway/attempt/outcome.ts';
import { failedDomainNodeIds, rememberFailedDomains } from '../apps/gateway/policy/model-fallback.ts';
import { buildBudgetExhaustedResponse, buildClientErrorResponse, summarizeFailoverAttempts } from '../apps/gateway/response/errors.ts';
import { loadExecutionConfig } from '../src/config/nodes.ts';
import { classifyUpstreamStatus, KIND } from '../src/reliability/classify.ts';
import { __resetKeyGroupForTests, credentialPeers, credentialSlotId, noteKeyGroup429 } from '../src/reliability/shared-credential-group.ts';
import { __resetTier1StateForTests, getTier1Account, getTier1Model, getTier1ModelPerf } from '../src/reliability/tier1-state.ts';

// A physical-model rejection is local to its route, while malformed
// client payloads must not trigger speculative cross-Provider replay.
const missing422 = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), 'No endpoints found for model physical-max');
assert.equal(missing422.kind, KIND.MODEL_MISSING);
assert.equal(missing422.action, 'rotate');
assert.equal(missing422.modelScoped, true);
const unavailable422 = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), '{"error":{"code":"model_unavailable"}}');
assert.equal(unavailable422.kind, KIND.MODEL_MISSING);
assert.equal(unavailable422.action, 'rotate');
const noProviders422 = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), 'No available providers');
assert.equal(noProviders422.kind, KIND.MODEL_MISSING);
assert.equal(noProviders422.action, 'rotate');
const endpoint422 = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), '{"error":{"code":"endpoint_not_found"}}');
assert.equal(endpoint422.kind, KIND.ENDPOINT_NOT_FOUND);
assert.equal(endpoint422.action, 'rotate');
assert.equal(endpoint422.counted, false);
const invalid422 = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), 'invalid request body: required field missing');
assert.equal(invalid422.kind, KIND.CLIENT);
assert.equal(invalid422.action, 'stop');
const invalid400 = classifyUpstreamStatus(400, new Headers(), {}, Date.now(), 'invalid JSON in request body');
assert.equal(invalid400.action, 'stop', 'malformed client payload must not rotate across Keys');
const compatible400 = classifyUpstreamStatus(400, new Headers(), {}, Date.now(), 'unsupported parameter: reasoning_effort');
assert.equal(compatible400.action, 'rotate', 'provider-specific 400 can use another Key');
const incompatible422 = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), 'unsupported parameter: stream_options');
assert.equal(incompatible422.action, 'rotate', 'explicit 422 protocol incompatibility may rotate');
assert.equal(incompatible422.counted, false);
const unsupportedTool422 = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), 'This model does not support tools');
assert.equal(unsupportedTool422.kind, KIND.CLIENT, 'unsupported tools is not a missing physical model');
assert.equal(unsupportedTool422.action, 'rotate');
// Code-model Providers often return only an OpenAI-style error.code, not the
// English "unsupported parameter" phrase. That must not terminate failover.
for (const code of ['unsupported_parameter', 'unsupported_value', 'unknown_parameter', 'unsupported_tool_type']) {
  const result = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), JSON.stringify({ error: { code, param: 'reasoning.effort' } }));
  assert.equal(result.kind, KIND.CLIENT, code);
  assert.equal(result.action, 'rotate', code);
  assert.equal(result.counted, false, code);
}
for (const code of ['model_not_found', 'invalid_model', 'deployment_not_found']) {
  const result = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), JSON.stringify({ error: { code } }));
  assert.equal(result.kind, KIND.MODEL_MISSING, code);
  assert.equal(result.action, 'rotate', code);
  assert.equal(result.modelScoped, true, code);
}
const schema422 = classifyUpstreamStatus(
  422,
  new Headers(),
  {},
  Date.now(),
  JSON.stringify({ detail: [{ type: 'extra_forbidden', loc: ['body', 'reasoning_effort'], msg: 'Extra inputs are not permitted' }] }),
);
assert.equal(schema422.action, 'rotate', 'top-level unsupported Code parameter may use another node');
for (const field of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'logprobs']) {
  const optionalField422 = classifyUpstreamStatus(
    422,
    new Headers(),
    {},
    Date.now(),
    JSON.stringify({ detail: [{ type: 'extra_forbidden', loc: ['body', field] }] }),
  );
  assert.equal(optionalField422.action, 'rotate', field + ' is an optional upstream parameter, not malformed client JSON');
  assert.equal(optionalField422.physicalRouteFailure, true);
}
const malformedSchema422 = classifyUpstreamStatus(
  422,
  new Headers(),
  {},
  Date.now(),
  JSON.stringify({
    detail: [
      { type: 'extra_forbidden', loc: ['body', 'reasoning_effort'] },
      { type: 'missing', loc: ['body', 'messages'] },
    ],
  }),
);
assert.equal(malformedSchema422.action, 'stop', 'missing required fields must never trigger a Key rotation');
const nestedSchema422 = classifyUpstreamStatus(
  422,
  new Headers(),
  {},
  Date.now(),
  JSON.stringify({ detail: [{ type: 'extra_forbidden', loc: ['body', 'tools', 0, 'function', 'parameters'] }] }),
);
assert.equal(nestedSchema422.action, 'stop', 'malformed nested tools are client-owned');
const machineEndpoint422 = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), '{"error":{"code":"unsupported_endpoint"}}');
assert.equal(machineEndpoint422.kind, KIND.ENDPOINT_NOT_FOUND);
assert.equal(machineEndpoint422.action, 'rotate');
for (const code of ['invalid_request_error', 'context_length_exceeded', 'invalid_json']) {
  const result = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), JSON.stringify({ error: { code, message: 'Invalid request body' } }));
  assert.equal(result.action, 'stop', 'genuine client 422 must not consume alternate Keys');
}
const opaque422 = classifyUpstreamStatus(422, new Headers(), {}, Date.now(), '{"error":{"message":"Unprocessable entity"}}');
assert.equal(opaque422.action, 'rotate', 'opaque 422 may try another physical route');
assert.equal(opaque422.uncertain422, true);
assert.equal(opaque422.physicalRouteFailure, true);
assert.equal(classifyUpstreamStatus(422, new Headers(), {}, Date.now(), '{"error":{"code":"invalid_json"}}').action, 'stop');
const unavailable503 = classifyUpstreamStatus(503, new Headers(), {}, Date.now(), 'temporarily unavailable');
assert.equal(unavailable503.action, 'rotate');

const source = 'Code-Ultra';
const effective = 'Code-Max';
const node = {
  id: 'free-key-model-target',
  tier: 'tier-1',
  provider: 'offline-provider',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  models: { [source]: 'physical-ultra', [effective]: 'physical-max' },
};
// Across logical-model rounds a physically failed Key must never be reused,
// even if its other model name resolves to a different upstream model.
const otherKey = { ...node, id: 'another-physical-key' };
const skippedPeer = { ...node, id: 'skipped-before-dispatch' };
const domains = new Set();
const keyNodes = new Map([node, otherKey, skippedPeer].map((entry) => [entry.id, entry]));
rememberFailedDomains(domains, keyNodes, new Set([node.id, skippedPeer.id]), source, [
  { node_id: node.id, dispatched: true, kind: 'server' },
  { node_id: skippedPeer.id, dispatched: false, kind: 'server' },
]);
const forbidden = failedDomainNodeIds([node, otherKey, skippedPeer], effective, domains);
assert.equal(forbidden.has(node.id), true, 'failed Key must be excluded for a different physical model');
assert.equal(forbidden.has(otherKey.id), false, 'fresh Key must remain eligible');
assert.equal(forbidden.has(skippedPeer.id), false, 'un-dispatched peer must remain eligible for other models');
assert.equal(failedDomainNodeIds([node, otherKey, skippedPeer], source, domains).has(skippedPeer.id), true);
const missingOnlyDomains = new Set();
rememberFailedDomains(missingOnlyDomains, keyNodes, new Set([node.id]), source, [{ node_id: node.id, dispatched: true, kind: 'model_missing' }]);
assert.equal(
  failedDomainNodeIds([node, otherKey], effective, missingOnlyDomains).has(node.id),
  false,
  'a missing model must not disable other models on the same Key',
);

const groupedA = { ...node, id: 'nvidia-04', baseUrl: 'https://integrate.api.nvidia.com/v1', keyGroup: 'nvidia-key-04' };
const groupedOmni = { ...node, id: 'omni-04', baseUrl: groupedA.baseUrl, keyGroup: 'nvidia-key-04', models: { Omni: 'physical-omni' } };
const groupedAlias = { ...node, id: 'alias-04', baseUrl: groupedA.baseUrl, keyGroup: 'nvidia-key-04', models: { Alias: 'physical-max' } };
const separateGroup = { ...groupedOmni, id: 'omni-05', keyGroup: 'nvidia-key-05' };
assert.deepEqual(
  credentialPeers([groupedA, groupedOmni, separateGroup], groupedA).map((x) => x.id),
  ['omni-04'],
);
assert.equal(credentialSlotId(groupedA), credentialSlotId(groupedOmni));
assert.notEqual(credentialSlotId(groupedA), credentialSlotId(separateGroup));
__resetKeyGroupForTests();
assert.equal(noteKeyGroup429(groupedA, 'physical-max', 100_000), 'model');
assert.equal(noteKeyGroup429(groupedOmni, 'physical-omni', 101_000), 'account');
assert.equal(noteKeyGroup429(separateGroup, 'physical-omni', 101_000), 'model');
__resetKeyGroupForTests();
const nodeInput = {
  id: 'test-node',
  provider: 'openai',
  base_url: 'https://example.invalid/v1',
  models: { Code: 'physical-code' },
  key_group: 'same-key',
};
const config = loadExecutionConfig({
  AIG_TIER1_NODES_01: JSON.stringify([nodeInput]),
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'test-node': 'test-only-credential' }),
});
assert.equal(config.nodes[0]?.keyGroup, 'same-key', 'config must retain declared non-secret Key group');
const invalidGroup = loadExecutionConfig({
  AIG_TIER1_NODES_01: JSON.stringify([{ ...nodeInput, key_group: 'INVALID GROUP' }]),
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'test-node': 'test-only-credential' }),
});
assert.equal(invalidGroup.nodes.length, 0, 'invalid shared Key group is rejected, not silently normalized');

// A route-scoped 422 is not six independent failures when all free Keys
// advertise one physical model. A different model on the same Key survives.
const sharedPrimary = { ...node, baseUrl: 'https://provider.invalid/v1' };
const sharedPhysical = { ...node, id: 'same-provider-other-key', baseUrl: 'https://provider.invalid/v1' };
const differentPhysical = {
  ...node,
  id: 'different-physical',
  baseUrl: 'https://provider.invalid/v1',
  models: { [source]: 'other-upstream', [effective]: 'other-physical' },
};
const sharedNodes = new Map([sharedPrimary, sharedPhysical, differentPhysical].map((entry) => [entry.id, entry]));
const routeDomains = new Set();
rememberFailedDomains(routeDomains, sharedNodes, new Set([sharedPrimary.id]), source, [
  {
    node_id: node.id,
    effective_model: source,
    dispatched: true,
    surface: 'chat_completions',
    status: 422,
    kind: 'client',
  },
]);
const routeOptions = failedDomainNodeIds([node, sharedPhysical, differentPhysical], source, routeDomains, 'chat_completions');
assert.equal(routeOptions.has(sharedPhysical.id), true, 'do not retry an opaque 422 on an equivalent physical route');
assert.equal(routeOptions.has(differentPhysical.id), false, 'distinct physical models stay eligible');
const alternateSurface = failedDomainNodeIds([node, sharedPhysical], source, routeDomains, 'responses');
assert.equal(alternateSurface.has(sharedPhysical.id), false, 'different protocol surfaces are independent');
const switchedModel = failedDomainNodeIds([node, sharedPhysical], effective, routeDomains, 'chat_completions');
assert.equal(switchedModel.has(sharedPhysical.id), false, 'different physical models on the same Key remain usable');

const logs = [];
const makeState = () => ({
  requestedModel: source,
  requestedModelAlias: source,
  requestId: 'offline-fallback',
  attempted: new Set(),
  attempts: [],
  logicalAttempts: 0,
  dispatches: 0,
  failureKinds: {},
  maxAttempts: 8,
  maxDispatches: 8,
  hedges: 0,
  logger: {
    info(message) {
      logs.push(message);
    },
    debug() {},
    error() {},
  },
});
const makeContext = (state) => ({
  state,
  requestedModel: source,
  reqDescriptor: { model: effective, route: 'openai_chat', protocol: 'openai', surface: 'chat_completions', bodyChars: 20 },
  tier1ReleaseToken: null,
  env: {},
  ctx: { waitUntil() {} },
  logger: state.logger,
  requestId: 'offline-fallback',
  upstreamProtocol: 'openai',
  surface: 'chat_completions',
  attemptStartMs: Date.now() - 150,
  attemptSettlement: { observedUsage: null, settled: true },
});

__resetTier1StateForTests();
// The request-level alias intentionally differs from the physical dispatch
// descriptor. Only the descriptor is the evidence of which model failed.
const state = makeState();
const c = makeContext(state);
const opaquePeer = { ...node, id: 'same-physical-other-key', baseUrl: 'https://provider.invalid/v1' };
const opaqueThirdPeer = { ...opaquePeer, id: 'third-physical-key' };
const opaquePrimary = { ...node, baseUrl: 'https://provider.invalid/v1' };
const opaqueState = makeState();
opaqueState.nodes = [
  opaquePrimary,
  opaquePeer,
  opaqueThirdPeer,
  { ...opaquePeer, id: 'different-model', models: { [source]: 'other-ultra', [effective]: 'other-physical' } },
];
recordOutcome(opaqueState, opaquePrimary, opaque422, makeContext(opaqueState), { status: 422, latencyMs: 90 });
assert.equal(opaqueState.attempted.has(opaquePeer.id), false, 'first opaque 422 permits one alternate Key for the same route');
recordOutcome(opaqueState, opaquePeer, opaque422, makeContext(opaqueState), { status: 422, latencyMs: 90 });
assert.equal(opaqueState.attempted.has(opaqueThirdPeer.id), true, 'second opaque 422 blocks remaining equivalent Key routes');
assert.equal(opaqueState.attempted.has('different-model'), false, 'a different physical route remains available');
recordOutcome(state, node, classifyUpstreamStatus(503, new Headers(), {}, Date.now(), 'temporary unavailable'), c, { status: 503, latencyMs: 200 });
assert.equal(getTier1Model(node.id, effective).consecutiveFailures, 1);
assert.equal(getTier1Model(node.id, source).consecutiveFailures, 0);
assert.equal(state.attempts[0].effective_model, effective);
assert.equal(state.attempts[0].upstream_model, 'physical-max');
assert.equal(state.attempted.has(node.id), true, 'the failed Key is excluded from this request even with unused attempt slots');

// The same failure class on another pass must not poison the original alias.
recordOutcome(state, node, classifyUpstreamStatus(503, new Headers(), {}, Date.now(), 'temporary unavailable'), makeContext(state), {
  status: 503,
  latencyMs: 200,
});
assert.equal(getTier1Model(node.id, effective).consecutiveFailures, 2);
assert.equal(getTier1Model(node.id, source).cooldownUntil, 0);

__resetTier1StateForTests();
// Later failures and pre-dispatch rejections must not resurrect an attempted Key.
// A request with no new candidates now stops rather than replaying the Key.
const groupedMap = new Map([groupedA, groupedOmni].map((entry) => [entry.id, entry]));
const scoped429 = new Set();
rememberFailedDomains(scoped429, groupedMap, new Set([groupedA.id]), effective, [
  { node_id: groupedA.id, dispatched: true, kind: 'rate_limit', rate_limit_scope: 'model' },
]);
assert.equal(failedDomainNodeIds([groupedOmni], 'Omni', scoped429).has(groupedOmni.id), false, 'model 429 must not suppress Omni');
const account429 = new Set();
rememberFailedDomains(account429, groupedMap, new Set([groupedA.id]), effective, [
  { node_id: groupedA.id, dispatched: true, kind: 'rate_limit', rate_limit_scope: 'account' },
]);
assert.equal(failedDomainNodeIds([groupedOmni], 'Omni', account429).has(groupedOmni.id), true, 'account 429 must exclude sibling node ID');

__resetTier1StateForTests();
const groupCooldownState = makeState();
groupCooldownState.nodes = [groupedA, groupedOmni, groupedAlias, separateGroup];
recordOutcome(
  groupCooldownState,
  groupedA,
  classifyUpstreamStatus(429, new Headers(), {}, Date.now(), 'daily quota exhausted'),
  makeContext(groupCooldownState),
  {
    status: 429,
    latencyMs: 50,
  },
);
assert.ok(getTier1Account(groupedOmni.id).accountCooldownUntil > Date.now(), 'shared Key inherits account-wide cooldown');
assert.equal(getTier1Account(separateGroup.id).accountCooldownUntil, 0, 'other Key group remains usable');

__resetTier1StateForTests();
const modelCooldownState = makeState();
modelCooldownState.nodes = [groupedA, groupedOmni, groupedAlias];
recordOutcome(
  modelCooldownState,
  groupedA,
  classifyUpstreamStatus(429, new Headers(), {}, Date.now(), 'requests per minute'),
  makeContext(modelCooldownState),
  {
    status: 429,
    latencyMs: 50,
  },
);
assert.ok(getTier1Model(groupedAlias.id, 'Alias').cooldownUntil > Date.now(), 'same physical model on the shared Key inherits model cooldown');
assert.equal(getTier1Account(groupedOmni.id).accountCooldownUntil, 0, 'model 429 does not cool the whole Key');
assert.equal(getTier1Model(groupedOmni.id, 'Omni').cooldownUntil, 0, 'different physical Omni model remains usable');
__resetTier1StateForTests();
const staleAfter429 = makeState();
recordOutcome(staleAfter429, node, classifyUpstreamStatus(503, new Headers(), {}, Date.now(), 'temporary outage'), makeContext(staleAfter429), {
  status: 503,
  latencyMs: 120,
});
assert.equal(staleAfter429.attempted.has(node.id), true);
recordOutcome(
  staleAfter429,
  node,
  classifyUpstreamStatus(429, new Headers({ 'Retry-After': '240' }), {}, Date.now(), 'quota exhausted'),
  makeContext(staleAfter429),
  { status: 429, latencyMs: 70 },
);
assert.equal(staleAfter429.failureKinds.rate_limit, 1, '429 must remain classified without reopening a spent Key');

__resetTier1StateForTests();
const staleAfterRefusal = makeState();
recordOutcome(
  staleAfterRefusal,
  node,
  classifyUpstreamStatus(503, new Headers(), {}, Date.now(), 'temporary outage'),
  makeContext(staleAfterRefusal),
  { status: 503, latencyMs: 120 },
);
rotateWithNeutralEnd(staleAfterRefusal, node, KIND.AUTH, makeContext(staleAfterRefusal), true);
assert.equal(staleAfterRefusal.attempted.has(node.id), true, 'pre-dispatch refusal must keep the Key excluded');
assert.equal(staleAfterRefusal.dispatches, 1, 'pre-dispatch rejection must not be charged as a Provider call');

__resetTier1StateForTests();
const staleAfterTierChange = makeState();
recordOutcome(
  staleAfterTierChange,
  node,
  classifyUpstreamStatus(503, new Headers(), {}, Date.now(), 'temporary outage'),
  makeContext(staleAfterTierChange),
  { status: 503, latencyMs: 120 },
);
const tokenNode = { ...node, id: 'token-node', tier: 'tier-2' };
recordOutcome(
  staleAfterTierChange,
  tokenNode,
  classifyUpstreamStatus(429, new Headers({ 'Retry-After': '15' }), {}, Date.now(), 'rate limit'),
  makeContext(staleAfterTierChange),
  { status: 429, latencyMs: 70 },
);
assert.equal(staleAfterTierChange.attempted.has(node.id), true, 'an older Tier 1 failure must remain excluded');

__resetTier1StateForTests();
const throttled = makeState();
recordOutcome(
  throttled,
  node,
  classifyUpstreamStatus(429, new Headers({ 'Retry-After': '15' }), {}, Date.now(), 'requests per minute'),
  makeContext(throttled),
  {
    status: 429,
    latencyMs: 80,
  },
);
assert.ok(getTier1Model(node.id, effective).cooldownUntil > Date.now());
assert.equal(getTier1Model(node.id, source).cooldownUntil, 0);

// Duplicate 404 endpoints are a request-local routing defect, not new
// capacity on every different free key. Keep paid and alternate routes usable.
__resetTier1StateForTests();
const endpointPeers = [
  { ...node, id: 'same-endpoint-a', baseUrl: 'https://same.example/v1' },
  { ...node, id: 'same-endpoint-b', baseUrl: 'https://same.example/v1' },
  { ...node, id: 'different-endpoint', baseUrl: 'https://other.example/v1' },
  { ...node, id: 'different-model', baseUrl: 'https://same.example/v1', models: { [effective]: 'other-physical' } },
  { ...node, id: 'paid-same-endpoint', tier: 'tier-2', baseUrl: 'https://same.example/v1' },
  { ...node, id: 'different-surface', baseUrl: 'https://same.example/v1', surfaces: ['responses'] },
];
const endpointState = makeState();
endpointState.nodes = endpointPeers;
recordOutcome(endpointState, endpointPeers[0], classifyUpstreamStatus(404, new Headers(), {}, Date.now(), 'Not Found'), makeContext(endpointState), {
  status: 404,
  latencyMs: 20,
});
assert.equal(endpointState.attempted.has('same-endpoint-b'), true, 'equivalent free key should not re-dispatch a missing endpoint');
for (const id of ['different-endpoint', 'different-model', 'paid-same-endpoint', 'different-surface']) {
  assert.equal(endpointState.attempted.has(id), false, id + ' must remain eligible');
}
assert.equal(endpointState.logicalAttempts, 1, 'skipped duplicate endpoints must consume no extra attempts');
assert.equal(endpointState.dispatches, 1, 'skipped duplicate endpoints must consume no extra physical dispatch');
// A 404 that explicitly concerns model entitlement must not exclude an
// independent Key on the same physical endpoint. Machine-readable missing
// model codes follow the same Key-local rule.
for (const body of [
  '{"error":{"code":"model_not_found"}}',
  '{"error":{"code":"model_access_denied"}}',
  '{"error":{"message":"You are not authorized to access model physical-max"}}',
]) {
  const modelAccess404 = classifyUpstreamStatus(404, new Headers(), {}, Date.now(), body);
  assert.equal(modelAccess404.kind, KIND.MODEL_MISSING, body);
  assert.equal(modelAccess404.modelScoped, true, body);
  const accessState = makeState();
  accessState.nodes = endpointPeers;
  recordOutcome(accessState, endpointPeers[0], modelAccess404, makeContext(accessState), { status: 404, latencyMs: 20 });
  assert.equal(accessState.attempted.has('same-endpoint-b'), false, 'model access 404 must preserve alternate Key');
}
const missingModelState = makeState();
missingModelState.nodes = endpointPeers;
recordOutcome(
  missingModelState,
  endpointPeers[0],
  classifyUpstreamStatus(404, new Headers(), {}, Date.now(), 'Model does not exist'),
  makeContext(missingModelState),
  { status: 404, latencyMs: 20 },
);
assert.equal(missingModelState.attempted.has('same-endpoint-b'), false, 'model-missing must not suppress a separate key');
const endpoint422State = makeState();
endpoint422State.nodes = endpointPeers;
recordOutcome(endpoint422State, endpointPeers[0], endpoint422, makeContext(endpoint422State), {
  status: 422,
  latencyMs: 20,
});
assert.equal(endpoint422State.attempted.has('same-endpoint-b'), true, 'explicit 422 endpoint rejection must skip equivalent routes');
assert.equal(endpoint422State.attempted.has('different-endpoint'), false);
assert.equal(endpoint422State.dispatches, 1);
const throttleState = makeState();
throttleState.nodes = endpointPeers;
recordOutcome(
  throttleState,
  endpointPeers[0],
  classifyUpstreamStatus(429, new Headers({ 'retry-after': '3' }), {}, Date.now(), 'rate limit'),
  makeContext(throttleState),
  { status: 429, latencyMs: 20 },
);
assert.equal(throttleState.attempted.has('same-endpoint-b'), false, '429 must not suppress a separate free key');

__resetTier1StateForTests();
const success = makeState();
const successContext = makeContext(success);
recordTier1NonStreamTtft(successContext, node, {}, () => true);
assert.ok((getTier1ModelPerf(node.id, effective)?.ttftEwma ?? 0) > 0);
assert.equal(getTier1ModelPerf(node.id, source)?.ttftEwma ?? null, null);

recordOutcome(success, node, classifyUpstreamStatus(503, new Headers(), {}, Date.now(), 'temporary unavailable'), makeContext(success), {
  status: 503,
  latencyMs: 100,
});
assert.equal(getTier1Model(node.id, effective).consecutiveFailures, 1);
recordNodeSuccess(successContext, node, 120);
assert.equal(getTier1Model(node.id, effective).consecutiveFailures, 0);
assert.equal(getTier1Model(node.id, source).consecutiveFailures, 0);
assert.ok(!JSON.stringify(success.attempts).includes('physical-ultra'), 'source model must not be blamed for target failure');
__resetTier1StateForTests();

// Public diagnostic summary proves that cross-model and cross-tier fallback
// really dispatched, while protecting Key IDs, Provider and physical models.
const diagnosticAttempts = [
  { tier: 'tier-1', node_id: 'secret-node-1', provider: 'secret-provider', effective_model: 'Code-Max', dispatched: false },
  {
    tier: 'tier-1',
    node_id: 'secret-node-1',
    provider: 'secret-provider',
    upstream_model: 'secret-physical',
    effective_model: 'Code-Max',
    dispatched: true,
  },
  { tier: 'tier-1', node_id: 'secret-node-2', effective_model: 'Code-Max', dispatched: true },
  { tier: 'tier-2', node_id: 'secret-node-3', effective_model: 'Code-Pro', dispatched: true },
];
const failover = summarizeFailoverAttempts(diagnosticAttempts).failover_summary;
assert.deepEqual(failover, {
  model_switches: 1,
  distinct_models: 2,
  tier1_dispatches: 2,
  tier2_dispatches: 1,
  other_dispatches: 0,
  truncated: false,
});
assert.deepEqual(summarizeFailoverAttempts([{ dispatched: false, effective_model: 'Code-Max' }]), {});
assert.equal(JSON.stringify(failover).includes('secret-'), false);
const longTrace = Array.from({ length: 90 }, (_, i) => ({
  tier: i % 2 === 0 ? 'tier-1' : 'tier-2',
  effective_model: i % 2 === 0 ? 'Code-Max' : 'Code-Pro',
  dispatched: true,
}));
const bounded = summarizeFailoverAttempts(longTrace).failover_summary;
assert.equal(bounded?.truncated, true);
assert.equal((bounded?.tier1_dispatches ?? 0) + (bounded?.tier2_dispatches ?? 0), 64);
const diagnosticState = {
  attempts: diagnosticAttempts,
  logicalAttempts: 3,
  dispatches: 3,
  hedges: 0,
  failureKinds: { rate_limit: 1, headers_timeout: 1, server: 1 },
};
const diagnosticRequest = new Request('https://gateway.example.invalid/v1/chat/completions', { method: 'POST' });
const rejectedResponse = buildClientErrorResponse(
  diagnosticRequest,
  {},
  'openai_chat',
  'offline-request',
  'Code-Max',
  422,
  'secret private upstream detail',
  diagnosticState,
  false,
);
assert.equal(rejectedResponse.status, 422);
const rejectedText = await rejectedResponse.text();
assert.deepEqual(JSON.parse(rejectedText).error.details.failover_summary, failover);
assert.equal(rejectedText.includes('secret-'), false);
const exhaustedResponse = buildBudgetExhaustedResponse(diagnosticRequest, {}, 'openai_chat', 'offline-request', 'Code-Max', diagnosticState, false);
assert.equal(exhaustedResponse.status, 504);
const exhaustedText = await exhaustedResponse.text();
assert.deepEqual(JSON.parse(exhaustedText).error.details.failover_summary, failover);
assert.equal(exhaustedText.includes('secret-'), false);

console.log('Tier 1 effective-model attribution and anonymous failover diagnostics contracts passed offline.');
