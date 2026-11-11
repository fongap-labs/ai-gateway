#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// No network, secrets, Worker bindings or production deployment.
import assert from 'node:assert/strict';
import {
  authorizeExecutionRequest,
  buildExecutionHeaders,
  EXECUTION_CONTRACT_VERSION,
  EXECUTION_ERROR_CODE,
  EXECUTION_WIRE_RESULT,
  parseExecutionInvocation,
  parseExecutionResponse,
  serializeExecutionError,
} from '../packages/contracts/execution.ts';
import { centerResponseDeadlineMs } from '../src/config/timeouts.ts';

const now = Date.now();
assert.equal(centerResponseDeadlineMs(now + 10_000, now), now + 9_750);
assert.equal(centerResponseDeadlineMs(now + 100, now), now + 90);
const key = 'local-test-center-key-32-characters-minimum';
const invocation = {
  requestId: '12345678-1234-1234-1234-123456789abc',
  nodeId: 'test-node',
  logicalModel: 'code-pro',
  surface: 'chat_completions',
  deadlineMs: now + 20_000,
};
const allowed = new Set(['chat_completions']);
const headers = buildExecutionHeaders(invocation, 'x-aig-inference-auth', key);
const makeRequest = (h) => new Request('https://inference.internal/internal/execute', { method: 'POST', headers: h });
const request = makeRequest(headers);
assert.equal(headers.get('x-aig-contract-version'), EXECUTION_CONTRACT_VERSION);
assert.deepEqual(parseExecutionInvocation(request, allowed, now), invocation);
assert.equal(authorizeExecutionRequest(request, key, 'x-aig-inference-auth'), true);
assert.equal(authorizeExecutionRequest(request, `${key}wrong`, 'x-aig-inference-auth'), false);
assert.equal(authorizeExecutionRequest(request, 'short', 'x-aig-inference-auth'), false);
assert.equal(authorizeExecutionRequest(request, key, 'authorization'), false);
assert.equal(headers.has('authorization'), false);
assert.equal(headers.has('cookie'), false);

for (const [name, value] of [
  ['x-aig-contract-version', '2'],
  ['x-aig-request-id', 'invalid'],
  ['x-aig-node-id', 'bad/node'],
  ['x-aig-model', ''],
  ['x-aig-surface', 'images_generations'],
  ['x-aig-deadline-ms', String(now - 1)],
  ['x-aig-deadline-ms', String(now + 600_001)],
  ['x-aig-deadline-ms', '999999999999999'],
]) {
  const modified = new Headers(headers);
  modified.set(name, value);
  assert.equal(parseExecutionInvocation(makeRequest(modified), allowed, now), null, name);
}
assert.equal(parseExecutionInvocation(request, new Set(['images_generations']), now), null);

const translated = { ...invocation, inputSurface: 'messages', preferNonstream: true };
const translatedHeaders = buildExecutionHeaders(translated, 'x-aig-inference-auth', key);
const translatedRequest = makeRequest(translatedHeaders);
assert.deepEqual(parseExecutionInvocation(translatedRequest, allowed, now), translated);
assert.equal(translatedHeaders.get('x-aig-input-surface'), 'messages');
assert.equal(translatedHeaders.get('x-aig-contract-version'), '2');
assert.equal(translatedHeaders.get('x-aig-conversion-prefer-nonstream'), 'true');
assert.equal(headers.has('x-aig-input-surface'), false);
for (const [name, value] of [
  ['x-aig-input-surface', 'images_generations'],
  ['x-aig-input-surface', 'chat_completions'],
  ['x-aig-input-surface', ''],
  ['x-aig-input-surface', 'forged'],
  ['x-aig-conversion-prefer-nonstream', 'false'],
  ['x-aig-conversion-prefer-nonstream', 'TRUE'],
]) {
  const modified = new Headers(translatedHeaders);
  modified.set(name, value);
  assert.equal(parseExecutionInvocation(makeRequest(modified), allowed, now), null, `${name}=${value}`);
}
const standalonePreference = new Headers(headers);
standalonePreference.set('x-aig-conversion-prefer-nonstream', 'true');
assert.equal(parseExecutionInvocation(makeRequest(standalonePreference), allowed, now), null);
const downgraded = new Headers(translatedHeaders);
downgraded.set('x-aig-contract-version', EXECUTION_CONTRACT_VERSION);
assert.equal(parseExecutionInvocation(makeRequest(downgraded), allowed, now), null);
const v2WithoutConversion = new Headers(headers);
v2WithoutConversion.set('x-aig-contract-version', '2');
assert.equal(parseExecutionInvocation(makeRequest(v2WithoutConversion), allowed, now), null);
const returnedObject = {
  ...translated,
  returnObject: true,
  upstreamHeadersDeadlineMs: now + 10_000,
  bufferedResponseDeadlineMs: now + 19_000,
};
const returnedHeaders = buildExecutionHeaders(returnedObject, 'x-aig-inference-auth', key);
assert.equal(returnedHeaders.get('x-aig-contract-version'), '3');
assert.equal(returnedHeaders.get('x-aig-return-object'), 'true');
assert.deepEqual(parseExecutionInvocation(makeRequest(returnedHeaders), allowed, now), returnedObject);
assert.equal(returnedHeaders.get('x-aig-upstream-headers-deadline-ms'), String(now + 10_000));
assert.equal(returnedHeaders.get('x-aig-buffered-response-deadline-ms'), String(now + 19_000));
for (const [name, value] of [
  ['x-aig-contract-version', '2'],
  ['x-aig-contract-version', '1'],
  ['x-aig-return-object', 'false'],
  ['x-aig-return-object', ''],
  ['x-aig-conversion-prefer-nonstream', 'false'],
]) {
  const invalid = new Headers(returnedHeaders);
  invalid.set(name, value);
  assert.equal(parseExecutionInvocation(makeRequest(invalid), allowed, now), null, `v3 ${name}`);
}
const v3WithoutPreference = new Headers(returnedHeaders);
v3WithoutPreference.delete('x-aig-conversion-prefer-nonstream');
assert.equal(parseExecutionInvocation(makeRequest(v3WithoutPreference), allowed, now), null);
const v3WithoutInput = new Headers(returnedHeaders);
v3WithoutInput.delete('x-aig-input-surface');
assert.equal(parseExecutionInvocation(makeRequest(v3WithoutInput), allowed, now), null);
for (const [name, value] of [
  ['x-aig-upstream-headers-deadline-ms', String(now - 1)],
  ['x-aig-upstream-headers-deadline-ms', String(now + 20_001)],
  ['x-aig-buffered-response-deadline-ms', String(now - 1)],
  ['x-aig-buffered-response-deadline-ms', String(now + 20_001)],
  ['x-aig-buffered-response-deadline-ms', 'not-a-deadline'],
]) {
  const invalid = new Headers(returnedHeaders);
  invalid.set(name, value);
  assert.equal(parseExecutionInvocation(makeRequest(invalid), allowed, now), null, `${name}=${value}`);
}
const v2WithObject = new Headers(translatedHeaders);
v2WithObject.set('x-aig-return-object', 'true');
assert.equal(parseExecutionInvocation(makeRequest(v2WithObject), allowed, now), null);

const streamed = { ...invocation, inputSurface: 'messages', returnStream: true, displayModel: 'public-chat-model' };
const streamedHeaders = buildExecutionHeaders(streamed, 'x-aig-inference-auth', key);
assert.equal(streamedHeaders.get('x-aig-contract-version'), '4');
assert.equal(streamedHeaders.get('x-aig-return-stream'), 'true');
assert.deepEqual(parseExecutionInvocation(makeRequest(streamedHeaders), allowed, now), streamed);
assert.equal(streamedHeaders.get('x-aig-display-model'), 'public-chat-model');
for (const [name, value] of [
  ['x-aig-contract-version', '3'],
  ['x-aig-contract-version', '2'],
  ['x-aig-return-stream', 'false'],
  ['x-aig-return-stream', ''],
  ['x-aig-display-model', ''],
  ['x-aig-display-model', 'x'.repeat(129)],
  ['x-aig-conversion-prefer-nonstream', 'true'],
  ['x-aig-return-object', 'true'],
]) {
  const invalid = new Headers(streamedHeaders);
  invalid.set(name, value);
  assert.equal(parseExecutionInvocation(makeRequest(invalid), allowed, now), null, `v4 ${name}`);
}
const v4NoInput = new Headers(streamedHeaders);
v4NoInput.delete('x-aig-input-surface');
assert.equal(parseExecutionInvocation(makeRequest(v4NoInput), allowed, now), null);
const v1WithV4Marker = new Headers(headers);
v1WithV4Marker.set('x-aig-return-stream', 'true');
assert.equal(parseExecutionInvocation(makeRequest(v1WithV4Marker), allowed, now), null);

const cfg = { maxEvents: 100, maxOutputUnits: 200, maxToolEvents: 30, maxToolArgUnits: 1000, maxOutputTokens: 0 };
const budgetStream = { ...streamed, streamBudget: { mode: 'error', cfg } };
const budgetHeaders = buildExecutionHeaders(budgetStream, 'x-aig-inference-auth', key);
assert.equal(budgetHeaders.get('x-aig-contract-version'), '5');
assert.deepEqual(parseExecutionInvocation(makeRequest(budgetHeaders), allowed, now), budgetStream);
assert.equal(streamedHeaders.has('x-aig-stream-budget'), false);
for (const invalidBudget of [
  '',
  '{',
  '[]',
  JSON.stringify({ mode: 'error', cfg: { ...cfg, maxOutputUnits: 0 } }),
  JSON.stringify({ mode: 'error', cfg: { ...cfg, maxOutputUnits: 1.5 } }),
  JSON.stringify({ mode: 'bad', cfg }),
  JSON.stringify({ mode: 'error', cfg: { ...cfg, extra: 1 } }),
  JSON.stringify({ mode: 'error', cfg: { ...cfg, maxEvents: 100000000 } }),
  JSON.stringify({ mode: 'error', cfg, extra: true }),
  'x'.repeat(513),
]) {
  const invalid = new Headers(budgetHeaders);
  invalid.set('x-aig-stream-budget', invalidBudget);
  assert.equal(parseExecutionInvocation(makeRequest(invalid), allowed, now), null, `invalid v5 budget: ${invalidBudget.slice(0, 30)}`);
}
for (const version of ['1', '2', '3', '4', '9']) {
  const invalid = new Headers(budgetHeaders);
  invalid.set('x-aig-contract-version', version);
  assert.equal(parseExecutionInvocation(makeRequest(invalid), allowed, now), null, `v5 downgrade ${version}`);
}
const missing = new Headers(budgetHeaders);
missing.delete('x-aig-stream-budget');
assert.equal(parseExecutionInvocation(makeRequest(missing), allowed, now), null);
const v4WithBudget = new Headers(streamedHeaders);
v4WithBudget.set('x-aig-stream-budget', budgetHeaders.get('x-aig-stream-budget'));
assert.equal(parseExecutionInvocation(makeRequest(v4WithBudget), allowed, now), null);

const collected = { ...invocation, inputSurface: 'messages', returnObject: true };
const collectedHeaders = buildExecutionHeaders(collected, 'x-aig-inference-auth', key);
assert.equal(collectedHeaders.get('x-aig-contract-version'), '6');
assert.deepEqual(parseExecutionInvocation(makeRequest(collectedHeaders), allowed, now), collected);
const budgetedCollected = { ...collected, streamBudget: { mode: 'error', cfg } };
const budgetedCollectedHeaders = buildExecutionHeaders(budgetedCollected, 'x-aig-inference-auth', key);
assert.equal(budgetedCollectedHeaders.get('x-aig-contract-version'), '6');
assert.deepEqual(parseExecutionInvocation(makeRequest(budgetedCollectedHeaders), allowed, now), budgetedCollected);
for (const [name, value] of [
  ['x-aig-contract-version', '3'],
  ['x-aig-contract-version', '5'],
  ['x-aig-return-object', 'false'],
  ['x-aig-conversion-prefer-nonstream', 'true'],
  ['x-aig-return-stream', 'true'],
  ['x-aig-display-model', 'forged-model'],
  ['x-aig-stream-budget', '{'],
]) {
  const invalid = new Headers(budgetedCollectedHeaders);
  invalid.set(name, value);
  assert.equal(parseExecutionInvocation(makeRequest(invalid), allowed, now), null, `v6 ${name}`);
}
const v6WithoutObject = new Headers(collectedHeaders);
v6WithoutObject.delete('x-aig-return-object');
assert.equal(parseExecutionInvocation(makeRequest(v6WithoutObject), allowed, now), null);

console.log('Execution contracts v1-v6: strict budgets, isolation, version and authorization validation passed.');

// Error serialization retains the historical Inference and Generation envelope
// shapes. The response parser must never infer dispatch from a missing marker.
const inferenceProblem = serializeExecutionError(504, EXECUTION_ERROR_CODE.CENTER_UPSTREAM_HEADERS_TIMEOUT, {
  retryable: true,
  result: EXECUTION_WIRE_RESULT.ATTEMPTED,
});
assert.deepEqual(await inferenceProblem.json(), { error: { code: 'center_upstream_headers_timeout', retryable: true } });
assert.equal(inferenceProblem.headers.get('x-aig-retryable'), 'true');
const generationProblem = serializeExecutionError(502, EXECUTION_ERROR_CODE.GENERATION_OUTCOME_UNKNOWN, {
  result: EXECUTION_WIRE_RESULT.ATTEMPTED,
});
assert.deepEqual(await generationProblem.json(), { error: { code: 'generation_outcome_unknown' } });
assert.equal(generationProblem.headers.get('x-aig-retryable'), null);

function centerResult(status, code, result) {
  return new Response(null, { status, headers: { 'x-aig-error-kind': code, 'x-aig-result': result } });
}
for (const [status, code, phase] of [
  [502, EXECUTION_ERROR_CODE.CENTER_UPSTREAM_NETWORK, 'upstream-network'],
  [504, EXECUTION_ERROR_CODE.CENTER_UPSTREAM_HEADERS_TIMEOUT, 'upstream-headers'],
  [502, 'unknown_error', 'upstream-attempted'],
]) {
  const parsed = parseExecutionResponse(centerResult(status, code, EXECUTION_WIRE_RESULT.ATTEMPTED));
  assert.equal(parsed.phase, phase);
  assert.equal(parsed.verifiedPreDispatchRotation, false, 'an attempted fetch may already have reached the Provider');
}
for (const [status, code] of [
  [404, EXECUTION_ERROR_CODE.CENTER_ROUTE_UNAVAILABLE],
  [504, EXECUTION_ERROR_CODE.CENTER_UPSTREAM_HEADERS_TIMEOUT],
]) {
  const parsed = parseExecutionResponse(centerResult(status, code, EXECUTION_WIRE_RESULT.SKIPPED));
  assert.equal(parsed.phase, 'pre-dispatch');
  assert.equal(parsed.verifiedPreDispatchRotation, true);
}
for (const [status, code, result] of [
  [404, EXECUTION_ERROR_CODE.CENTER_ROUTE_UNAVAILABLE, EXECUTION_WIRE_RESULT.ATTEMPTED],
  [504, EXECUTION_ERROR_CODE.CENTER_UPSTREAM_HEADERS_TIMEOUT, EXECUTION_WIRE_RESULT.DISPATCHED],
  [404, 'unknown_error', EXECUTION_WIRE_RESULT.SKIPPED],
  [503, EXECUTION_ERROR_CODE.CENTER_ROUTE_UNAVAILABLE, EXECUTION_WIRE_RESULT.SKIPPED],
  [404, EXECUTION_ERROR_CODE.CENTER_ROUTE_UNAVAILABLE, 'forged-result'],
]) {
  assert.equal(parseExecutionResponse(centerResult(status, code, result)).verifiedPreDispatchRotation, false);
}
const overDeadline = parseExecutionResponse(
  centerResult(504, EXECUTION_ERROR_CODE.CENTER_EXECUTION_DEADLINE, EXECUTION_WIRE_RESULT.DISPATCHED),
);
assert.equal(overDeadline.phase, 'execution-deadline');
assert.equal(overDeadline.verifiedPreDispatchRotation, false);
assert.equal(parseExecutionResponse(new Response(null, { status: 503 })).phase, 'center-unconfirmed');
console.log('Execution phases and error serialization: pre-dispatch proof, unknown outcomes, transport stages passed.');
