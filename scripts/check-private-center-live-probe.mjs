#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Offline direct test of the production diagnostics path. No network,
// Cloudflare, actual Secret, or Provider call is permitted.

import assert from 'node:assert/strict';
import { handleGenerationCenterRequest } from '../apps/generation/index.ts';
import { handleInferenceCenterRequest } from '../apps/inference/index.ts';
import { handlePerceptionCenterRequest } from '../apps/perception/index.ts';
import { preflight } from '../apps/gateway/preflight.ts';

const secrets = {
  AIG_INFERENCE_AUTH_KEY: 'offline-inference-secret-00000000000000001',
  AIG_PERCEPTION_AUTH_KEY: 'offline-perception-secret-0000000000000002',
  AIG_GENERATION_AUTH_KEY: 'offline-generation-secret-0000000000000003',
};
const keys = {
  AIG_ACCESS_KEY_MAX: 'offline-max-diagnostics-key',
  AIG_ACCESS_KEY_ULTRA: 'offline-ultra-diagnostics-key',
  AIG_ACCESS_KEY_AIR: 'offline-air-key',
  AIG_ACCESS_MODELS_MAX: '*',
  AIG_ACCESS_MODELS_ULTRA: '*',
  AIG_ACCESS_MODELS_AIR: '*',
  AIG_DIAGNOSTICS_GROUPS: '*',
};
const centers = [
  { name: 'inference', binding: 'AIG_INFERENCE_SERVICE', secret: 'AIG_INFERENCE_AUTH_KEY', handle: handleInferenceCenterRequest },
  { name: 'perception', binding: 'AIG_PERCEPTION_SERVICE', secret: 'AIG_PERCEPTION_AUTH_KEY', handle: handlePerceptionCenterRequest },
  { name: 'generation', binding: 'AIG_GENERATION_SERVICE', secret: 'AIG_GENERATION_AUTH_KEY', handle: handleGenerationCenterRequest },
];
const env = { ...secrets, ...keys };
const calls = new Map();

for (const center of centers) {
  env[center.binding] = {
    fetch(request) {
      calls.set(center.name, (calls.get(center.name) ?? 0) + 1);
      return center.handle(request, { [center.secret]: secrets[center.secret] });
    },
  };
}

const originalFetch = globalThis.fetch;
let providerCalls = 0;
globalThis.fetch = async () => {
  providerCalls++;
  throw new Error('Provider calls are forbidden in private-center live probe tests');
};

function request(key, query = '?probe=private-centers') {
  return new Request('https://gateway.example.test/health' + query, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}
async function result(testEnv, key, query) {
  const r = await preflight(request(key, query), testEnv, {});
  assert.equal(r.ok, false);
  return r.response;
}

try {
  const accepted = await result(env, keys.AIG_ACCESS_KEY_ULTRA);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
  const json = await accepted.json();
  assert.equal(json.ready, true);
  assert.deepEqual(json.centers, { inference: 'ok', perception: 'ok', generation: 'ok' });
  assert.ok(!JSON.stringify(json).includes(secrets.AIG_INFERENCE_AUTH_KEY));

  const max = await result(env, keys.AIG_ACCESS_KEY_MAX);
  assert.equal(max.status, 200);
  const counts = [...calls.values()].reduce((sum, n) => sum + n, 0);
  assert.equal(counts, 12, '3 private centers receive one accepted and one rejected request per probe');

  const unprivileged = await result(env, keys.AIG_ACCESS_KEY_AIR);
  assert.equal(unprivileged.status, 403);
  const unauthenticated = await result(env, undefined);
  assert.equal(unauthenticated.status, 401);
  assert.equal([...calls.values()].reduce((sum, n) => sum + n, 0), counts);

  const usual = await result(env, keys.AIG_ACCESS_KEY_ULTRA, '');
  assert.equal((await usual.json()).centers, undefined);
  assert.equal([...calls.values()].reduce((sum, n) => sum + n, 0), counts);

  const missingBinding = { ...env, AIG_INFERENCE_SERVICE: undefined };
  const absent = await result(missingBinding, keys.AIG_ACCESS_KEY_ULTRA);
  assert.equal(absent.status, 503);
  assert.equal((await absent.json()).centers.inference, 'missing-binding');

  const wrongKey = { ...env, AIG_PERCEPTION_AUTH_KEY: 'wrong-perception-key-0000000000000000' };
  const denied = await result(wrongKey, keys.AIG_ACCESS_KEY_ULTRA);
  assert.equal(denied.status, 503);
  assert.equal((await denied.json()).centers.perception, 'unauthorized');

  const unsafe = {
    ...env,
    AIG_GENERATION_SERVICE: {
      async fetch(req) {
        return new Response(JSON.stringify({ status: 'ok', center: 'generation' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
  const unsafeResult = await result(unsafe, keys.AIG_ACCESS_KEY_ULTRA);
  assert.equal(unsafeResult.status, 503);
  assert.equal((await unsafeResult.json()).centers.generation, 'auth-not-enforced');

  const missingKey = { ...env, AIG_INFERENCE_AUTH_KEY: undefined };
  const absentKey = await result(missingKey, keys.AIG_ACCESS_KEY_ULTRA);
  assert.equal((await absentKey.json()).centers.inference, 'missing-key');

  assert.equal(providerCalls, 0);
  console.log('Authenticated private-center live probe contracts passed offline (no Provider calls).');
} finally {
  globalThis.fetch = originalFetch;
}
