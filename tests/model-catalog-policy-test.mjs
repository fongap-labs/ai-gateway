#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Model catalog / runtime policy separation contracts:
//   - catalog facts (capabilities, reasoning efforts, modalities) and
//     runtime policy (failover policy binding, visibility, UI grouping)
//     are distinct concepts with disjoint field ownership
//   - the flat AIG_MODELS_CONFIG operator schema is unchanged
//   - adding a model (and even a new model family) is configuration-only:
//     no router, scheduler, reliability, or transport source change

import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { loadModelsConfig, getModelsConfigDiagnostics } from '../src/config/models.ts';
import { loadModelRegistry, modelRegistryEntry } from '../src/config/registry.ts';
import { loadPoliciesConfig } from '../src/config/policies.ts';
import { getPolicy } from '../src/config/policies.ts';
import { buildModelFallbackRounds } from '../src/request/model-fallback.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}`); console.error(e?.stack || e); process.exitCode = 1; }
}

const ACCESS_KEY = 'model-catalog-policy-test-key';
const FLAT_ENTRY = {
  policy: 'fast',
  capabilities: { vision: true },
  reasoning_efforts: ['high'],
  modalities: { input: ['text', 'image'], output: ['text'] },
  visibility: 'internal',
  display_order: 7,
  group: 'lab',
  ui_visible: false,
};
const ENV_WITH_ENTRY = { AIG_MODELS_CONFIG: JSON.stringify({ 'code-pro': FLAT_ENTRY }) };

test('the operator-facing AIG_MODELS_CONFIG schema stays flat', () => {
  assert.deepEqual(getModelsConfigDiagnostics(ENV_WITH_ENTRY), [],
    'a pre-separation flat entry must parse without any diagnostic');
  const models = loadModelsConfig(ENV_WITH_ENTRY);
  assert.ok(models['code-pro'], 'entry loads');
});

test('catalog facts and runtime policy resolve into disjoint concepts', () => {
  const reg = loadModelRegistry(ENV_WITH_ENTRY);
  const entry = reg['code-pro'];
  const catalogKeys = Object.keys(entry.catalog).sort();
  const policyKeys = Object.keys(entry.policy).sort();
  assert.deepEqual(catalogKeys, ['capabilities', 'modalities', 'reasoning_efforts']);
  assert.deepEqual(policyKeys, ['display_order', 'group', 'policy', 'ui_visible', 'visibility']);
  for (const key of policyKeys) {
    assert.ok(!(key in entry.catalog), `policy field "${key}" must not appear on catalog facts`);
  }
  for (const key of catalogKeys) {
    assert.ok(!(key in entry.policy), `catalog field "${key}" must not appear on runtime policy`);
  }
});

test('each side keeps its declared values and independent defaults', () => {
  const reg = loadModelRegistry(ENV_WITH_ENTRY);
  const entry = reg['code-pro'];
  assert.deepEqual(entry.catalog.capabilities,
    { tools: false, reasoning: false, vision: true, stream: true, ocr: false },
    'catalog defaults merge with declared capabilities');
  assert.deepEqual(entry.catalog.reasoning_efforts, ['high']);
  assert.deepEqual(entry.catalog.modalities, { input: ['text', 'image'], output: ['text'] });
  assert.deepEqual(entry.policy, { policy: 'fast', visibility: 'internal', display_order: 7, group: 'lab', ui_visible: false });

  const plain = loadModelRegistry({ AIG_MODELS_CONFIG: '{"fresh-model":{}}' })['fresh-model'];
  assert.deepEqual(plain.catalog.capabilities, { tools: false, reasoning: false, vision: false, stream: true, ocr: false });
  assert.deepEqual(plain.catalog.reasoning_efforts, []);
  assert.equal('modalities' in plain.catalog, false);
  assert.deepEqual(plain.policy, { policy: 'default', visibility: 'public', display_order: 100, group: 'general', ui_visible: true });
});

test('unknown models get the same conservative catalog/policy defaults', () => {
  const def = modelRegistryEntry({}, 'never-configured');
  assert.equal(def.catalog.capabilities.tools, false);
  assert.deepEqual(def.catalog.reasoning_efforts, []);
  assert.equal(def.policy.policy, 'default');
  assert.equal(def.policy.visibility, 'public');
});

test('policy tier inference stays unchanged (Air fast / tiered long-reasoning)', () => {
  const builtins = loadPoliciesConfig({});
  const models = loadModelsConfig({ AIG_MODELS_CONFIG: JSON.stringify({ 'Code-Air': {}, 'Code-Pro': {} }) });
  assert.equal(getPolicy('Code-Air', models, builtins), builtins.fast);
  assert.equal(getPolicy('Code-Pro', models, builtins), builtins['long-reasoning']);
  assert.equal(getPolicy('Anything', models, builtins), builtins.default);
});

test('new model families stay data-driven through the known-model catalog', () => {
  const known = new Set(['Draft-Ultra', 'Draft-Max', 'Draft-Pro']);
  const rounds = buildModelFallbackRounds('Draft-Ultra', known);
  assert.deepEqual(rounds[0], ['Draft-Ultra', 'Draft-Max', 'Draft-Pro'],
    'an arbitrary future family needs no source change, only catalog/config entries');
});

// ---- Scenario: adding a model is configuration-only, end to end ----

const rawNode = (id, models) => ({
  id,
  provider: 'mock',
  base_url: `https://${id}.example.com/v1`,
  models,
});
const envFor = (nodes, extra = {}) => ({
  AIG_ACCESS_KEY_ULTRA: ACCESS_KEY,
  AIG_ACCESS_MODELS_ULTRA: '*',
  AIG_PROTOCOL_FALLBACKS: 'disable',
  TIER1_SCHEDULER_SEED: 'model-catalog-policy',
  AIG_TIER1_NODES_01: JSON.stringify(nodes),
  AIG_TIER1_CREDENTIALS_01: JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, `secret-${n.id}`]))),
  ...extra,
});

test('scenario: a brand-new model routes and reports via configuration alone', async () => {
  const upstreamCalls = [];
  const finish = () => { globalThis.fetch = undefined; };
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    upstreamCalls.push(url.hostname);
    assert.equal(url.pathname, '/v1/chat/completions');
    return new Response(JSON.stringify({
      id: 'chatcmpl-x', object: 'chat.completion',
      model: 'gpt-brand-new',
      choices: [{ index: 0, message: { role: 'assistant', content: 'fresh model served' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const env = envFor([rawNode('brand-new-node', { 'Brand-New': 'gpt-brand-new' })], {
      AIG_MODELS_CONFIG: JSON.stringify({
        'Brand-New': { capabilities: { tools: true }, reasoning_efforts: ['medium'] },
      }),
    });

    const chat = await worker.fetch(new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
      body: JSON.stringify({ model: 'Brand-New', messages: [{ role: 'user', content: 'hi' }] }),
    }), env, {});
    assert.equal(chat.status, 200, 'the new model must be callable with zero source changes');
    assert.match(await chat.text(), /fresh model served/);
    assert.deepEqual(upstreamCalls, ['brand-new-node.example.com']);

    const list = await worker.fetch(new Request('https://gateway.example.com/v1/models', {
      headers: { authorization: `Bearer ${ACCESS_KEY}` },
    }), env, {});
    assert.equal(list.status, 200);
    const payload = await list.json();
    const entry = payload.data.find((m) => m.id === 'Brand-New');
    assert.ok(entry, 'the new model appears in /v1/models driven by its catalog facts');
    assert.equal(entry.supports_tools, true);
    assert.deepEqual(entry.reasoning_efforts, ['medium']);
  } finally { finish(); }
});

console.log(`[model-catalog-policy-test] ${passed} checks passed`);
