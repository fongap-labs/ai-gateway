#!/usr/bin/env node
import assert from 'node:assert/strict';
import { storeEdgeCacheResponse } from '../apps/gateway/cache/edge-cache.ts';

const previousCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
let storedBody;
let resolveStored;
let timeout;
const stored = new Promise((resolve, reject) => {
  resolveStored = resolve;
  timeout = setTimeout(() => reject(new Error('edge cache write did not complete')), 1_000);
});
Object.defineProperty(globalThis, 'caches', {
  configurable: true,
  value: {
    default: {
      async put(_key, response) {
        storedBody = await response.text();
        resolveStored();
      },
    },
  },
});

try {
  assert.doesNotThrow(() =>
    storeEdgeCacheResponse(
      {
        waitUntil() {
          throw new Error('background task registration unavailable');
        },
      },
      new Request('https://gateway.invalid/__gateway_cache/v3/openai_chat/cache-key'),
      new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      60,
      false,
      'openai_chat',
    ),
  );
  await stored;
  assert.equal(storedBody, '{"ok":true}', 'cache storage should still complete after registration failure');
} finally {
  clearTimeout(timeout);
  if (previousCaches) Object.defineProperty(globalThis, 'caches', previousCaches);
  else delete globalThis.caches;
}

console.log('Edge-cache background registration failure is isolated from the request and cache task.');
