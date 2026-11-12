#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Offline-only: exercise Gateway-style Service Bindings and private-center auth.
// Every request is non-dispatching. No Cloudflare access, Provider calls or real keys.

import assert from 'node:assert/strict';
import { handleInferenceCenterRequest } from '../apps/inference/index.ts';
import { handlePerceptionCenterRequest } from '../apps/perception/index.ts';
import { handleGenerationCenterRequest } from '../apps/generation/index.ts';

const keys = {
  AIG_INFERENCE_AUTH_KEY: 'offline-inference-key-000000000000000000000001',
  AIG_PERCEPTION_AUTH_KEY: 'offline-perception-key-000000000000000000000002',
  AIG_GENERATION_AUTH_KEY: 'offline-generation-key-000000000000000000000003',
};
const centers = [
  {
    name: 'inference',
    binding: 'AIG_INFERENCE_SERVICE',
    secret: 'AIG_INFERENCE_AUTH_KEY',
    header: 'x-aig-inference-auth',
    method: 'GET',
    path: '/internal/health',
    status: 200,
    handle: handleInferenceCenterRequest,
  },
  {
    name: 'perception',
    binding: 'AIG_PERCEPTION_SERVICE',
    secret: 'AIG_PERCEPTION_AUTH_KEY',
    header: 'x-aig-perception-auth',
    method: 'POST',
    path: '/internal/execute',
    status: 400, // Authenticated, malformed contract: rejected before Provider dispatch.
    handle: handlePerceptionCenterRequest,
  },
  {
    name: 'generation',
    binding: 'AIG_GENERATION_SERVICE',
    secret: 'AIG_GENERATION_AUTH_KEY',
    header: 'x-aig-generation-auth',
    method: 'GET',
    path: '/internal/health',
    status: 200,
    handle: handleGenerationCenterRequest,
  },
];

function probeRequest(center, key) {
  const headers = key === undefined ? {} : { [center.header]: key };
  return new Request(`https://${center.name}.internal${center.path}`, {
    method: center.method,
    headers,
  });
}

async function probeBinding(gatewayEnv, center, key) {
  const binding = gatewayEnv[center.binding];
  assert.equal(typeof binding?.fetch, 'function', `${center.name} requires a Service Binding`);
  return binding.fetch(probeRequest(center, key));
}

const originalFetch = globalThis.fetch;
let upstreamCalls = 0;
globalThis.fetch = async () => {
  upstreamCalls++;
  throw new Error('No Provider or network requests are permitted in the private-center auth test');
};

try {
  const gatewayEnv = { ...keys };
  const bindingCalls = new Map();

  for (const center of centers) {
    const centerEnv = { [center.secret]: keys[center.secret] };
    gatewayEnv[center.binding] = {
      fetch(request) {
        bindingCalls.set(center.name, (bindingCalls.get(center.name) ?? 0) + 1);
        return center.handle(request, centerEnv);
      },
    };
  }

  for (const center of centers) {
    const key = keys[center.secret];
    const ok = await probeBinding(gatewayEnv, center, key);
    assert.equal(ok.status, center.status, `${center.name} authenticated probe status`);
    assert.equal(ok.headers.get('cache-control'), 'no-store', `${center.name} must not cache private responses`);
    if (center.name !== 'perception') {
      assert.match(ok.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await ok.json(), { status: 'ok', center: center.name });
    } else {
      assert.equal((await ok.json()).error.code, 'center_contract_invalid');
    }

    for (const rejectedKey of [undefined, 'wrong-key', 'x'.repeat(40), ...Object.values(keys).filter((value) => value !== key)]) {
      const rejected = await probeBinding(gatewayEnv, center, rejectedKey);
      assert.equal(rejected.status, 403, `${center.name} must reject missing, wrong or cross-center credentials`);
    }

    const missingSecret = await center.handle(probeRequest(center, key), {});
    assert.equal(missingSecret.status, 403, `${center.name} must reject missing expected Secret`);

    const wrongMethod = new Request(`https://${center.name}.internal${center.path}`, {
      method: center.method === 'GET' ? 'POST' : 'GET',
      headers: { [center.header]: key },
    });
    assert.equal((await center.handle(wrongMethod, { [center.secret]: key })).status, 404);
    assert.ok((bindingCalls.get(center.name) ?? 0) >= 6, `${center.name} binding must receive requests`);
  }

  // A swapped Service Binding cannot authenticate with another center's key.
  for (let i = 0; i < centers.length; i++) {
    const center = centers[i];
    const other = centers[(i + 1) % centers.length];
    const swapped = {
      ...gatewayEnv,
      [center.binding]: {
        fetch(request) {
          return other.handle(request, { [other.secret]: keys[other.secret] });
        },
      },
    };
    assert.equal((await probeBinding(swapped, center, keys[center.secret])).status, 403);
  }

  for (const center of centers) {
    const unbound = { ...gatewayEnv };
    delete unbound[center.binding];
    await assert.rejects(() => probeBinding(unbound, center, keys[center.secret]), /requires a Service Binding/);
  }
  assert.equal(upstreamCalls, 0, 'all checks must stop before any external Provider request');
  console.log('Private-center Service Binding and authentication contracts passed offline (3 centers; zero Provider calls).');
} finally {
  globalThis.fetch = originalFetch;
}
