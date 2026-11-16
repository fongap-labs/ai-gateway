#!/usr/bin/env node
import assert from 'node:assert/strict';
import { reuseRequestConversionPreflight } from '../apps/gateway/transport/request-conversion-cache.ts';

const state = {};
const body = { model: 'Code-Max', messages: [{ role: 'user', content: 'test' }] };
const key = JSON.stringify(['anthropic', 'openai_chat', false]);
let rpcCalls = 0;
const check = async () => {
  rpcCalls++;
  return { body, fidelity: 'lossless', diagnostics: [] };
};
const first = await reuseRequestConversionPreflight(state, body, key, check);
assert.strictEqual(await reuseRequestConversionPreflight(state, body, key, check), first);
assert.equal(rpcCalls, 1, 'the same request must only preflight the same pair once');
await reuseRequestConversionPreflight(state, body, JSON.stringify(['anthropic', 'openai_responses', false]), check);
assert.equal(rpcCalls, 2, 'distinct pair must be checked independently');
await reuseRequestConversionPreflight(state, body, JSON.stringify(['anthropic', 'openai_chat', true]), check);
assert.equal(rpcCalls, 3, 'stream preference affects conversion safety');

const transformed = { ...body, messages: [...body.messages] };
const transformedResult = await reuseRequestConversionPreflight(state, transformed, key, check);
assert.notStrictEqual(transformedResult, first);
assert.equal(rpcCalls, 4, 'changed request body must not reuse stale conversion evidence');
assert.strictEqual(await reuseRequestConversionPreflight(state, transformed, key, check), transformedResult);
assert.equal(rpcCalls, 4);

await reuseRequestConversionPreflight({}, transformed, key, check);
assert.equal(rpcCalls, 5, 'preflight evidence is never shared between requests');

let failures = 0;
const fail = async () => {
  failures++;
  throw new Error('temporary center failure');
};
const invalidKey = 'temporary-failure';
await assert.rejects(reuseRequestConversionPreflight(state, body, invalidKey, fail), /temporary center failure/);
await assert.rejects(reuseRequestConversionPreflight(state, body, invalidKey, fail), /temporary center failure/);
assert.equal(failures, 2, 'failed preflight must not be cached');

const pendingState = {};
let concurrentCalls = 0;
let releasePending;
const gate = new Promise((resolve) => {
  releasePending = resolve;
});
const concurrentCheck = async () => {
  concurrentCalls++;
  await gate;
  return { body, fidelity: 'portable', diagnostics: [] };
};
const firstPending = reuseRequestConversionPreflight(pendingState, body, key, concurrentCheck);
const secondPending = reuseRequestConversionPreflight(pendingState, body, key, concurrentCheck);
assert.strictEqual(firstPending, secondPending, 'in-flight checks must share one promise');
await Promise.resolve();
assert.equal(concurrentCalls, 1, 'parallel attempts must not duplicate preflight RPC');
releasePending();
assert.strictEqual(await firstPending, await secondPending);

console.log('Request-local conversion preflight passed: reuse, in-flight dedup, pair isolation, body replacement and failure eviction.');
