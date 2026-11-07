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
console.log('Execution contract v1: construction, validation, authorization and negative cases passed.');
