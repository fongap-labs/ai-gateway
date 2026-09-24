#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';

const ACCESS_KEY = 'family-rate-limit-test-key';
const calls = [];
__resetAllStateForTests();
__resetTier1StateForTests();
__resetTier1AffinityForTests();

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const body = init?.body ? JSON.parse(init.body) : {};
  calls.push({ host: url.hostname, model: body.model });
  return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '30' },
  });
};

const nodes = [
  { id: 'code-ultra-rl', provider: 'provider-ultra', base_url: 'https://code-ultra-rl.example.com/v1', priority: 10, models: { 'Code-Ultra': 'up-code-ultra' } },
  { id: 'code-max-rl', provider: 'provider-max', base_url: 'https://code-max-rl.example.com/v1', priority: 10, models: { 'Code-Max': 'up-code-max' } },
  { id: 'code-pro-rl', provider: 'provider-pro', base_url: 'https://code-pro-rl.example.com/v1', priority: 10, models: { 'Code-Pro': 'up-code-pro' } },
];

const env = {
  AIG_ACCESS_KEY_ULTRA: ACCESS_KEY,
  AIG_ACCESS_MODELS_ULTRA: '*',
  AIG_PROTOCOL_FALLBACKS: 'disable',
  AIG_TIER1_NODES_01: JSON.stringify(nodes),
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({
    'code-ultra-rl': 'k-ultra', 'code-max-rl': 'k-max', 'code-pro-rl': 'k-pro',
  }),
};

const request = new Request('https://gateway.example.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
  body: JSON.stringify({ model: 'Code-Ultra', messages: [{ role: 'user', content: 'continue the task' }] }),
});

const response = await worker.fetch(request, env, {});
const body = await response.json();
assert.equal(response.status, 503, 'all-transient compatible family exhaustion must remain retryable');
assert.match(body?.error?.message || '', /Transient failures exhausted the compatible-model failover plan/i);
assert.doesNotMatch(body?.error?.message || '', /Compatible model capacity is temporarily unavailable/i);
assert.doesNotMatch(body?.error?.message || '', /All attempted nodes failed/i);
assert.equal(response.headers.get('x-should-retry'), null);
const retryAfter = Number(response.headers.get('retry-after'));
assert.ok(Number.isFinite(retryAfter) && retryAfter >= 25 && retryAfter <= 30);
assert.equal(body?.error?.details?.failure_kinds?.rate_limit, 3);
assert.deepEqual(calls.map((c) => c.model), ['up-code-ultra', 'up-code-max', 'up-code-pro']);

calls.length = 0;
__resetAllStateForTests();
__resetTier1StateForTests();
__resetTier1AffinityForTests();

const auditNodes = [
  { id: 'audit-ultra-rl', provider: 'provider-audit-ultra', base_url: 'https://audit-ultra-rl.example.com/v1', priority: 10, models: { 'Audit-Ultra': 'up-audit-ultra' } },
  { id: 'audit-max-rl', provider: 'provider-audit-max', base_url: 'https://audit-max-rl.example.com/v1', priority: 10, models: { 'Audit-Max': 'up-audit-max' } },
  { id: 'audit-pro-rl', provider: 'provider-audit-pro', base_url: 'https://audit-pro-rl.example.com/v1', priority: 10, models: { 'Audit-Pro': 'up-audit-pro' } },
];

const auditEnv = {
  AIG_ACCESS_KEY_AGENT: ACCESS_KEY,
  AIG_ACCESS_MODELS_AGENT: '*',
  AIG_PROTOCOL_FALLBACKS: 'disable',
  AIG_TIER1_NODES_01: JSON.stringify(auditNodes),
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({
    'audit-ultra-rl': 'k-audit-ultra',
    'audit-max-rl': 'k-audit-max',
    'audit-pro-rl': 'k-audit-pro',
  }),
};

const auditRequest = new Request('https://gateway.example.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
  body: JSON.stringify({ model: 'Audit-Ultra', messages: [{ role: 'user', content: 'review the architecture' }] }),
});

const auditResponse = await worker.fetch(auditRequest, auditEnv, {});
assert.equal(auditResponse.status, 503);
assert.deepEqual(
  calls.map((c) => c.model),
  ['up-audit-ultra', 'up-audit-max', 'up-audit-pro'],
  'prefixed logical aliases must fail over across configured sibling tiers',
);

console.log('family rate-limit retry test passed.');
