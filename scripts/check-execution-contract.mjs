#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// No network, secrets, Worker bindings or production deployment.
import assert from 'node:assert/strict';
import {
  authorizeExecutionRequest,
  buildExecutionHeaders,
  EXECUTION_CONTRACT_VERSION,
  parseExecutionInvocation,
} from '../packages/contracts/execution.ts';

const now = Date.now();
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
const returnedObject = { ...translated, returnObject: true };
const returnedHeaders = buildExecutionHeaders(returnedObject, 'x-aig-inference-auth', key);
assert.equal(returnedHeaders.get('x-aig-contract-version'), '3');
assert.equal(returnedHeaders.get('x-aig-return-object'), 'true');
assert.deepEqual(parseExecutionInvocation(makeRequest(returnedHeaders), allowed, now), returnedObject);
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

console.log('Execution contract v1/v2/v3/v4: construction, validation, authorization and negative cases passed.');
