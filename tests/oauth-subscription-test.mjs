#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Tier 2 subscription OAuth contract tests:
//   - node config validation (auth:"oauth" is Tier 2 only, no static credential)
//   - AIG_OAUTH_PROVIDERS parsing (fail-closed)
//   - token encryption roundtrip (missing key fails closed)
//   - token store persistence via D1
//   - /oauth/start + /oauth/callback routes (PKCE, single-use state)
//   - dispatch-time credential resolution (Bearer headers, no-token rotation)

import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';
import { __resetSubscriptionCacheForTests } from '../src/oauth/resolve.ts';
import { __resetOAuthProvidersCacheForTests } from '../src/oauth/provider-configs.ts';
import { __resetTokenKeyCacheForTests } from '../src/oauth/crypto.ts';
import { loadOAuthProviders } from '../src/oauth/provider-configs.ts';
import { encryptSecret, decryptSecret, hasTokenKey } from '../src/oauth/crypto.ts';
import { storeSubscriptionToken, loadSubscriptionToken } from '../src/oauth/token-store.ts';

const ACCESS_KEY = 'test-access-key';
const RAW_KEY_BYTES = new Uint8Array(32).fill(7);
let KEY_B64 = '';
for (const byte of RAW_KEY_BYTES) KEY_B64 += String.fromCharCode(byte);
KEY_B64 = btoa(KEY_B64);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    __resetAllStateForTests();
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
    __resetSubscriptionCacheForTests();
    __resetOAuthProvidersCacheForTests();
    __resetTokenKeyCacheForTests();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

// ---- Minimal D1 mock for the oauth tables -------------------------------

class MockOAuthD1 {
  constructor() {
    this.tokens = new Map();
    this.flows = new Map();
    this.failWrites = false;
  }
  prepare(query) {
    const self = this;
    return {
      bind: (...values) => ({
        async first() {
          if (/FROM oauth_flow_states/.test(query)) {
            const state = values[0];
            const row = self.flows.get(state);
            return row ? { ...row } : null;
          }
          if (/FROM subscription_tokens/.test(query)) {
            const nodeId = values[0];
            const row = self.tokens.get(nodeId);
            return row ? { ...row } : null;
          }
          return null;
        },
        async run() {
          if (self.failWrites) throw new Error('mock write failure');
          if (/INSERT INTO oauth_flow_states/.test(query)) {
            const [state, provider, nodeId, verifier, createdAt] = values;
            self.flows.set(state, {
              state, provider, node_id: nodeId, code_verifier: verifier, created_at: createdAt,
            });
            return {};
          }
          if (/DELETE FROM oauth_flow_states WHERE state = \?/.test(query)) {
            self.flows.delete(values[0]);
            return {};
          }
          if (/DELETE FROM oauth_flow_states WHERE created_at/.test(query)) {
            const cutoff = values[0];
            for (const [state, row] of self.flows) {
              if (row.created_at < cutoff) self.flows.delete(state);
            }
            return {};
          }
          if (/INSERT INTO subscription_tokens/.test(query)) {
            // values: nodeId, provider, accessEnc, refreshEnc, tokenIv, refreshIv, expiresAt, updatedAt, accountId
            const [nodeId, provider, accessEnc, refreshEnc, tokenIv, refreshIv, expiresAt, updatedAt, accountId] = values;
            const existing = self.tokens.get(nodeId);
            self.tokens.set(nodeId, {
              node_id: nodeId, provider,
              access_token_enc: accessEnc,
              refresh_token_enc: refreshEnc ?? existing?.refresh_token_enc ?? null,
              token_iv: tokenIv,
              refresh_iv: refreshIv ?? existing?.refresh_iv ?? null,
              expires_at: expiresAt, status: 'active', updated_at: updatedAt,
              account_id: accountId ?? existing?.account_id ?? null,
              refresh_version: 0,
            });
            return { meta: { changes: 1 } };
          }
          // CAS refresh persist: last two binds are (nodeId, expectedVersion).
          if (/refresh_version = refresh_version \+ 1/.test(query)) {
            const nodeId = values[values.length - 2];
            const expectedVersion = values[values.length - 1];
            const row = self.tokens.get(nodeId);
            if (!row || row.refresh_version !== expectedVersion) {
              return { meta: { changes: 0 } };
            }
            // values: accessEnc, tokenIv, refreshEnc, refreshIv, expiresAt, now, nodeId, expectedVersion
            const [accessEnc, tokenIv, refreshEnc, refreshIv, expiresAt, updatedAt] = values;
            self.tokens.set(nodeId, {
              ...row,
              access_token_enc: accessEnc,
              token_iv: tokenIv,
              refresh_token_enc: refreshEnc ?? row.refresh_token_enc,
              refresh_iv: refreshIv ?? row.refresh_iv,
              expires_at: expiresAt, status: 'active', updated_at: updatedAt,
              refresh_version: row.refresh_version + 1,
            });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE subscription_tokens SET status/.test(query)) {
            const [status, updatedAt, nodeId] = values;
            const row = self.tokens.get(nodeId);
            if (row) self.tokens.set(nodeId, { ...row, status, updated_at: updatedAt });
            return { meta: { changes: row ? 1 : 0 } };
          }
          return {};
        },
      }),
    };
  }
}

// ---- Shared env helpers ----------------------------------------------------

const OAUTH_PROVIDERS_VAR = JSON.stringify({
  mock: {
    authorize_url: 'https://auth.mock.example.com/authorize',
    token_url: 'https://auth.mock.example.com/token',
    client_id: 'mock-client-id',
    scope: 'mock.scope',
    upstream_headers: { 'x-subscription-beta': 'mock-beta' },
  },
  // The openai override points at the mock endpoints so dispatch-path
  // tests exercise the real codex adapter against test doubles.
  openai: {
    authorize_url: 'https://auth.mock.example.com/authorize',
    token_url: 'https://auth.mock.example.com/token',
    client_id: 'mock-openai-client-id',
    scope: 'openid profile',
    upstream_headers: { 'x-subscription-beta': 'mock-beta' },
  },
  // The anthropic override points at the mock endpoints so dispatch-path
  // tests exercise the real claude adapter against test doubles.
  anthropic: {
    authorize_url: 'https://auth.mock.example.com/authorize',
    token_url: 'https://auth.mock.example.com/token',
    client_id: 'override-anthropic-client-id',
    scope: 'oauth override',
    upstream_headers: { 'x-subscription-beta': 'mock-beta' },
  },
});

function makeEnv({ tier1, tier2, db, extraEnv } = {}) {
  return {
    AIG_ACCESS_KEY_AIR: ACCESS_KEY,
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_OAUTH_PROVIDERS: OAUTH_PROVIDERS_VAR,
    AIG_TOKEN_ENCRYPTION_KEY: KEY_B64,
    AIG_PUBLIC_URL: 'https://gateway.example.com',
    ...(db ? { TOKEN_STATS_DB: db } : {}),
    ...(tier1 ? { AIG_TIER1_NODES_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { AIG_TIER2_NODES_01: JSON.stringify(tier2) } : {}),
    ...extraEnv,
  };
}

const tier2OauthNode = (id, provider = 'mock', extra = {}) => ({
  id, provider, auth: 'oauth',
  base_url: `https://${id}.example.com/v1`, models: { 'Code-Max': 'up-model' }, ...extra,
});

// ---- Config validation tests ----------------------------------------------

await test('Tier 2 auth:"oauth" node is accepted without a static credential', async () => {
  const env = makeEnv({ tier2: [tier2OauthNode('sub1')] });
  const res = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  const body = await res.json();
  assert.equal(body.status, 'ready');
  assert.ok(!body.diagnostics.some((d) => String(d).includes('sub1')), JSON.stringify(body.diagnostics));
});

await test('Tier 1 auth:"oauth" node is rejected', async () => {
  const env = makeEnv({
    tier1: [{ id: 'sub1', provider: 'mock', auth: 'oauth', base_url: 'https://sub1.example.com/v1', models: { 'Code-Max': 'up' } }],
    extraEnv: { AIG_TIER1_CREDENTIALS_01: JSON.stringify({ sub1: 'k' }) },
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  const body = await res.json();
  assert.ok(body.diagnostics.some((d) => String(d).includes('not allowed on tier-1')), JSON.stringify(body.diagnostics));
});

await test('Tier 3 auth:"oauth" node is rejected', async () => {
  const env = {
    ...makeEnv({}),
    AIG_TIER3_NODES_01: JSON.stringify([{ id: 'sub3', provider: 'mock', auth: 'oauth', base_url: 'https://sub3.example.com/v1', models: {} }]),
    AIG_TIER3_CREDENTIALS_01: JSON.stringify({ sub3: 'k' }),
  };
  const res = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  const body = await res.json();
  assert.ok(body.diagnostics.some((d) => String(d).includes('not allowed on tier-3')), JSON.stringify(body.diagnostics));
});

await test('unknown auth mode is rejected', async () => {
  const env = makeEnv({
    tier2: [{ id: 'subx', provider: 'mock', auth: 'api-key', base_url: 'https://subx.example.com/v1', models: {} }],
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  const body = await res.json();
  assert.ok(body.diagnostics.some((d) => String(d).includes('unknown auth mode')), JSON.stringify(body.diagnostics));
});

await test('auth:"oauth" node with a static credential is rejected (dual credential source)', async () => {
  const env = makeEnv({
    tier2: [tier2OauthNode('sub1')],
    extraEnv: { AIG_TIER2_CREDENTIALS_01: JSON.stringify({ sub1: 'static-key' }) },
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  const body = await res.json();
  assert.ok(body.diagnostics.some((d) => String(d).includes('must not have a static credential')), JSON.stringify(body.diagnostics));
});

// ---- Provider config parsing ----------------------------------------------

await test('unset AIG_OAUTH_PROVIDERS falls back to built-in defaults', async () => {
  const diagnostics = [];
  const config = loadOAuthProviders({}, diagnostics);
  assert.ok(config.anthropic, 'defaults present');
  assert.equal(diagnostics.length, 0);
});

await test('invalid AIG_OAUTH_PROVIDERS JSON falls back to built-in defaults', async () => {
  const diagnostics = [];
  const config = loadOAuthProviders({ AIG_OAUTH_PROVIDERS: '{invalid' }, diagnostics);
  assert.ok(config.anthropic, 'defaults present');
  assert.ok(diagnostics.some((d) => String(d).includes('not valid JSON')));
});

await test('provider entry missing client_id is dropped; defaults remain', async () => {
  const diagnostics = [];
  const raw = JSON.stringify({
    mock: {
      authorize_url: 'https://auth.mock.example.com/authorize',
      token_url: 'https://auth.mock.example.com/token',
      scope: 's',
    },
  });
  const config = loadOAuthProviders({ AIG_OAUTH_PROVIDERS: raw }, diagnostics);
  assert.ok(!config.mock, 'invalid entry dropped');
  assert.ok(config.anthropic, 'defaults remain');
  assert.ok(diagnostics.some((d) => String(d).includes('missing "client_id"')));
});

await test('non-https authorize_url is rejected; defaults remain', async () => {
  const diagnostics = [];
  const raw = JSON.stringify({
    mock: {
      authorize_url: 'http://auth.mock.example.com/authorize',
      token_url: 'https://auth.mock.example.com/token',
      client_id: 'c',
      scope: 's',
    },
  });
  const config = loadOAuthProviders({ AIG_OAUTH_PROVIDERS: raw }, diagnostics);
  assert.ok(!config.mock, 'invalid entry dropped');
  assert.ok(config.anthropic, 'defaults remain');
  assert.ok(diagnostics.some((d) => String(d).includes('must be an https URL')));
});

// ---- Encryption ------------------------------------------------------------

await test('token encryption roundtrip works with a configured key', async () => {
  const env = { AIG_TOKEN_ENCRYPTION_KEY: KEY_B64 };
  assert.equal(hasTokenKey(env), true);
  const secret = await encryptSecret(env, 'access-token-abc');
  assert.ok(secret);
  const plaintext = await decryptSecret(env, secret);
  assert.equal(plaintext, 'access-token-abc');
});

await test('encryption fails closed without a key', async () => {
  const secret = await encryptSecret({}, 'access-token-abc');
  assert.equal(secret, null);
  assert.equal(hasTokenKey({}), false);
});

await test('decryption with a different key fails', async () => {
  const env = { AIG_TOKEN_ENCRYPTION_KEY: KEY_B64 };
  const secret = await encryptSecret(env, 'access-token-abc');
  const otherBytes = new Uint8Array(32).fill(9);
  let otherB64 = '';
  for (const byte of otherBytes) otherB64 += String.fromCharCode(byte);
  const wrongEnv = { AIG_TOKEN_ENCRYPTION_KEY: btoa(otherB64) };
  const plaintext = await decryptSecret(wrongEnv, secret);
  assert.equal(plaintext, null);
});

// ---- Token store ------------------------------------------------------------

await test('subscription token persists and reloads through D1', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ db });
  const stored = await storeSubscriptionToken(env, {
    nodeId: 'sub1', provider: 'mock',
    accessToken: 'tok-1', refreshToken: 'ref-1',
    expiresAt: Date.now() + 3600_000,
  });
  assert.equal(stored, true);
  const loaded = await loadSubscriptionToken(env, 'sub1');
  assert.ok(loaded);
  assert.equal(loaded.accessToken, 'tok-1');
  assert.equal(loaded.refreshToken, 'ref-1');
  assert.equal(loaded.provider, 'mock');
});

await test('token store refuses to persist without D1 binding', async () => {
  const env = makeEnv({});
  const stored = await storeSubscriptionToken(env, {
    nodeId: 'sub1', provider: 'mock', accessToken: 'tok-1', refreshToken: null,
    expiresAt: Date.now() + 3600_000,
  });
  assert.equal(stored, false);
  assert.equal(await loadSubscriptionToken(env, 'sub1'), null);
});

await test('token ciphertext in D1 is not the plaintext token', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ db });
  await storeSubscriptionToken(env, {
    nodeId: 'sub1', provider: 'mock', accessToken: 'secret-token-value', refreshToken: null,
    expiresAt: Date.now() + 3600_000,
  });
  const row = db.tokens.get('sub1');
  assert.ok(row);
  assert.notEqual(row.access_token_enc, 'secret-token-value');
  assert.ok(row.access_token_enc.length > 0);
});

// ---- OAuth routes ------------------------------------------------------------

function withMockFetch(handler) {
  globalThis.fetch = handler;
}

await test('/oauth/start without a gateway key returns 401', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ tier2: [tier2OauthNode('sub1')], db });
  const res = await worker.fetch(new Request('https://gateway.example.com/oauth/start?provider=mock&node=sub1'), env, {});
  assert.equal(res.status, 401);
});

await test('/oauth/start with a valid key returns a PKCE redirect', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ tier2: [tier2OauthNode('sub1')], db });
  const res = await worker.fetch(new Request('https://gateway.example.com/oauth/start?provider=mock&node=sub1', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'https://auth.mock.example.com/authorize');
  assert.equal(location.searchParams.get('client_id'), 'mock-client-id');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://gateway.example.com/oauth/callback/mock');
  const state = location.searchParams.get('state');
  assert.ok(state);
  assert.ok(db.flows.has(state), 'flow state persisted in D1');
});

await test('/oauth/start with an unknown node returns 404', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ tier2: [tier2OauthNode('sub1')], db });
  const res = await worker.fetch(new Request('https://gateway.example.com/oauth/start?provider=mock&node=missing', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(res.status, 404);
});

await test('/oauth/start with a non-oauth node returns 400', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [{ id: 'static-node', provider: 'mock', base_url: 'https://static.example.com/v1', models: {} }],
    db,
    extraEnv: { AIG_TIER2_CREDENTIALS_01: JSON.stringify({ 'static-node': 'k' }) },
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/oauth/start?provider=mock&node=static-node', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(res.status, 400);
});

await test('/oauth/start without an encryption key returns 503 (fail-closed)', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ tier2: [tier2OauthNode('sub1')], db });
  delete env.AIG_TOKEN_ENCRYPTION_KEY;
  const res = await worker.fetch(new Request('https://gateway.example.com/oauth/start?provider=mock&node=sub1', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(res.status, 503);
});

await test('full callback flow stores the token and consumes the state', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ tier2: [tier2OauthNode('sub1')], db });

  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'auth.mock.example.com' && url.pathname === '/token') {
      const params = new URLSearchParams(String(init?.body || ''));
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('client_id'), 'mock-client-id');
      assert.ok(params.get('code_verifier'));
      assert.equal(params.get('redirect_uri'), 'https://gateway.example.com/oauth/callback/mock');
      return new Response(JSON.stringify({
        access_token: 'exchanged-access-token', refresh_token: 'exchanged-refresh-token', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const start = await worker.fetch(new Request('https://gateway.example.com/oauth/start?provider=mock&node=sub1', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  const location = new URL(start.headers.get('location'));
  const state = location.searchParams.get('state');

  const callback = await worker.fetch(new Request(
    `https://gateway.example.com/oauth/callback/mock?code=auth-code-123&state=${encodeURIComponent(state)}`,
  ), env, {});
  assert.equal(callback.status, 200);
  const row = db.tokens.get('sub1');
  assert.ok(row, 'token persisted');
  assert.notEqual(row.access_token_enc, 'exchanged-access-token', 'stored ciphertext');
  assert.ok(row.expires_at > Date.now());

  // Single-use: replaying the same state must fail and must not re-exchange.
  const replay = await worker.fetch(new Request(
    `https://gateway.example.com/oauth/callback/mock?code=auth-code-123&state=${encodeURIComponent(state)}`,
  ), env, {});
  assert.equal(replay.status, 400);
  assert.equal(db.flows.size, 0, 'flow state consumed');
});

await test('callback with a provider mismatch is rejected', async () => {
  const db = new MockOAuthD1();
  db.flows.set('state-123', {
    state: 'state-123', provider: 'mock', node_id: 'sub1',
    code_verifier: 'verifier', created_at: Date.now(),
  });
  const env = makeEnv({ tier2: [tier2OauthNode('sub1')], db });
  const res = await worker.fetch(new Request(
    'https://gateway.example.com/oauth/callback/anthropic?code=c&state=state-123',
  ), env, {});
  assert.equal(res.status, 400);
  assert.equal(db.flows.size, 0, 'state consumed even on mismatch');
});

await test('callback with an unknown state is rejected', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ tier2: [tier2OauthNode('sub1')], db });
  const res = await worker.fetch(new Request(
    'https://gateway.example.com/oauth/callback/mock?code=c&state=does-not-exist',
  ), env, {});
  assert.equal(res.status, 400);
});

await test('callback with an expired flow state is rejected', async () => {
  const db = new MockOAuthD1();
  db.flows.set('state-old', {
    state: 'state-old', provider: 'mock', node_id: 'sub1',
    code_verifier: 'verifier', created_at: Date.now() - 11 * 60 * 1000,
  });
  const env = makeEnv({ tier2: [tier2OauthNode('sub1')], db });
  const res = await worker.fetch(new Request(
    'https://gateway.example.com/oauth/callback/mock?code=c&state=state-old',
  ), env, {});
  assert.equal(res.status, 400);
});

// ---- Dispatch-time resolution -----------------------------------------------

const chatRequest = () => new Request('https://gateway.example.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
  body: JSON.stringify({ model: 'Code-Max', messages: [{ role: 'user', content: 'hi' }] }),
});

await test('Tier 2 oauth node dispatches with the resolved Bearer token', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ tier2: [tier2OauthNode('sub1', 'openai')], db });
  await storeSubscriptionToken(env, {
    nodeId: 'sub1', provider: 'openai', accessToken: 'resolved-token', refreshToken: null,
    expiresAt: Date.now() + 3600_000,
  });

  let seenAuth = null;
  let seenBeta = null;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'sub1.example.com') {
      seenAuth = init?.headers?.get('authorization');
      seenBeta = init?.headers?.get('x-subscription-beta');
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  assert.equal(seenAuth, 'Bearer resolved-token');
  assert.equal(seenBeta, 'mock-beta', 'upstream_headers from AIG_OAUTH_PROVIDERS applied');
});

await test('Tier 2 oauth node without a token rotates without contacting the upstream', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ tier2: [tier2OauthNode('sub1')], db });
  let upstreamContacted = false;
  withMockFetch(async () => {
    upstreamContacted = true;
    throw new Error('upstream must not be contacted');
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 502, 'all attempts rotate and the request ends exhausted');
  assert.equal(upstreamContacted, false);
});

await test('Tier 2 anthropic oauth node sends Bearer, not x-api-key', async () => {
  const db = new MockOAuthD1();
  // Use the built-in default anthropic provider (no AIG_OAUTH_PROVIDERS override)
  // to also verify defaults are in effect.
  const anthropicOauthNode = {
    id: 'claude-sub', provider: 'anthropic', auth: 'oauth',
    base_url: 'https://claude-sub.example.com', models: { 'Code-Max': 'up-model' },
  };
  const env = makeEnv({ tier2: [anthropicOauthNode], db });
  delete env.AIG_OAUTH_PROVIDERS; // use built-in defaults only
  await storeSubscriptionToken(env, {
    nodeId: 'claude-sub', provider: 'anthropic', accessToken: 'anthropic-oauth-token', refreshToken: null,
    expiresAt: Date.now() + 3600_000,
  });

  let authHeader = null;
  let apiKeyHeader = null;
  let betaHeader = null;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'claude-sub.example.com') {
      authHeader = init?.headers?.get('authorization');
      apiKeyHeader = init?.headers?.get('x-api-key');
      betaHeader = init?.headers?.get('anthropic-beta');
      return new Response(JSON.stringify({
        type: 'message', role: 'assistant', model: 'up-model',
        content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const messagesRequest = new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify({ model: 'Code-Max', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const res = await worker.fetch(messagesRequest, env, {});
  assert.equal(res.status, 200);
  assert.equal(authHeader, 'Bearer anthropic-oauth-token');
  assert.equal(apiKeyHeader, null, 'oauth anthropic nodes must not send x-api-key');
});

await test('expired token with no refresh token fails closed and rotates', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ tier2: [tier2OauthNode('sub1')], db });
  await storeSubscriptionToken(env, {
    nodeId: 'sub1', provider: 'mock', accessToken: 'old-token', refreshToken: null,
    expiresAt: Date.now() - 1000,
  });
  let upstreamContacted = false;
  withMockFetch(async () => {
    upstreamContacted = true;
    throw new Error('upstream must not be contacted');
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 502, 'expired token rotates to exhaustion');
  assert.equal(upstreamContacted, false);
  assert.equal(db.tokens.get('sub1')?.status, 'expired');
});

await test('refresh flow rotates the access token through the provider endpoint', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ tier2: [tier2OauthNode('sub1', 'openai')], db });
  await storeSubscriptionToken(env, {
    nodeId: 'sub1', provider: 'openai', accessToken: 'stale-token', refreshToken: 'refresh-1',
    expiresAt: Date.now() - 1000,
  });

  let refreshSeen = false;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'auth.mock.example.com' && url.pathname === '/token') {
      const params = new URLSearchParams(String(init?.body || ''));
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('refresh_token'), 'refresh-1');
      refreshSeen = true;
      return new Response(JSON.stringify({
        access_token: 'fresh-token', refresh_token: 'refresh-2', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.hostname === 'sub1.example.com') {
      assert.equal(init?.headers?.get('authorization'), 'Bearer fresh-token');
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  assert.equal(refreshSeen, true, 'refresh was exercised');
  const reloaded = await loadSubscriptionToken(env, 'sub1');
  assert.equal(reloaded.accessToken, 'fresh-token');
  assert.equal(reloaded.refreshToken, 'refresh-2');
});

console.log(`\nOAuth subscription tests: ${passed} passed, ${failed} failed.`);

// ---- Built-in defaults tests (no AIG_OAUTH_PROVIDERS needed) ---------------

await test('built-in defaults: anthropic/openai/google available without AIG_OAUTH_PROVIDERS', async () => {
  __resetOAuthProvidersCacheForTests();
  const config = loadOAuthProviders({});
  assert.ok(config.anthropic, 'anthropic default exists');
  assert.ok(config.openai, 'openai default exists');
  assert.ok(config.google, 'google default exists');
  assert.equal(config.anthropic.authorizeUrl, 'https://claude.ai/oauth/authorize');
  assert.equal(config.openai.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.ok(config.google.clientSecret, 'google has client_secret');
  assert.ok(config.google.manualRedirectUrl, 'google has manual_redirect_url');
});

await test('AIG_OAUTH_PROVIDERS overrides default per-provider (wholesale)', async () => {
  __resetOAuthProvidersCacheForTests();
  const config = loadOAuthProviders({
    AIG_OAUTH_PROVIDERS: JSON.stringify({
      anthropic: {
        authorize_url: 'https://override.example.com/auth',
        token_url: 'https://override.example.com/token',
        client_id: 'override-id',
        scope: 'override-scope',
      },
    }),
  });
  assert.equal(config.anthropic.clientId, 'override-id', 'anthropic overridden');
  assert.equal(config.openai.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann', 'openai still default');
});

await test('google manual paste: /oauth/start uses manual_redirect_url', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [{ id: 'gemini-sub', provider: 'google', auth: 'oauth', base_url: 'https://gen-lang.example.com/v1beta/openai', models: { 'Code-Max': 'gemini-pro' } }],
    db,
  });
  delete env.AIG_OAUTH_PROVIDERS;
  const res = await worker.fetch(new Request('https://gateway.example.com/oauth/start?provider=google&node=gemini-sub', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('codeassist.google.com'), 'uses Google manual redirect (in authorize URL)');
  assert.ok(body.includes('/oauth/paste'), 'tells user where to paste');
  assert.equal(db.flows.size, 1, 'flow state persisted');
});

await test('google manual paste: POST /oauth/paste exchanges with client_secret', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [{ id: 'gemini-sub', provider: 'google', auth: 'oauth', base_url: 'https://gen-lang.example.com/v1beta/openai', models: { 'Code-Max': 'gemini-pro' } }],
    db,
  });
  delete env.AIG_OAUTH_PROVIDERS;
  let exchangeBody = null;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'oauth2.googleapis.com') {
      exchangeBody = String(init?.body || '');
      return new Response(JSON.stringify({ access_token: 'g-token', refresh_token: 'g-refresh', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const startRes = await worker.fetch(new Request('https://gateway.example.com/oauth/start?provider=google&node=gemini-sub', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  const startBody = await startRes.text();
  const stateMatch = startBody.match(/state=([a-zA-Z0-9_-]+)/);
  assert.ok(stateMatch, 'state found');
  const state = stateMatch[1];
  const pasteRes = await worker.fetch(new Request('https://gateway.example.com/oauth/paste', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state, code: 'pasted-code' }).toString(),
  }), env, {});
  assert.equal(pasteRes.status, 200);
  assert.ok(db.tokens.get('gemini-sub'), 'token stored');
  assert.equal(db.flows.size, 0, 'flow state consumed');
  assert.ok(exchangeBody?.includes('client_secret'), 'client_secret in exchange');
});

await test('google manual paste: GET /oauth/paste shows form', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [{ id: 'gemini-sub', provider: 'google', auth: 'oauth', base_url: 'https://gen-lang.example.com/v1beta/openai', models: {} }],
    db,
  });
  delete env.AIG_OAUTH_PROVIDERS;
  await worker.fetch(new Request('https://gateway.example.com/oauth/start?provider=google&node=gemini-sub', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  const state = [...db.flows.keys()][0];
  assert.ok(state);
  const pasteRes = await worker.fetch(new Request(`https://gateway.example.com/oauth/paste?state=${encodeURIComponent(state)}`), env, {});
  assert.equal(pasteRes.status, 200);
  const body = await pasteRes.text();
  assert.ok(body.includes('<form'), 'form rendered');
  assert.ok(body.includes('name="code"'), 'code input present');
});

await test('anthropic override with client_secret includes it in the refresh grant', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [tier2OauthNode('an-secret', 'anthropic', { base_url: 'https://an-secret.example.com' })],
    db,
  });
  // A confidential-client override (client_secret present) must reach the
  // refresh grant body; public PKCE providers simply omit the secret.
  env.AIG_OAUTH_PROVIDERS = JSON.stringify({
    anthropic: {
      authorize_url: 'https://auth.mock.example.com/authorize',
      token_url: 'https://auth.mock.example.com/token',
      client_id: 'confidential-client-id',
      client_secret: 'confidential-secret',
      scope: 'oauth override',
    },
  });
  await storeSubscriptionToken(env, { nodeId: 'an-secret', provider: 'anthropic', accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 });
  let refreshBody = null;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'auth.mock.example.com' && url.pathname === '/token') {
      refreshBody = String(init?.body || '');
      return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.hostname === 'an-secret.example.com') {
      assert.equal(init?.headers?.get('authorization'), 'Bearer fresh');
      return new Response(JSON.stringify({
        type: 'message', role: 'assistant', model: 'up-model',
        content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected: ${url}`);
  });
  const messagesReq = new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify({ model: 'Code-Max', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const res = await worker.fetch(messagesReq, env, {});
  assert.equal(res.status, 200);
  assert.ok(refreshBody?.includes('client_secret'), 'client_secret in refresh');
  assert.ok(refreshBody?.includes('confidential-secret'), 'the configured secret value is sent');
});

await test('google dispatch fails closed by default (no verified subscription adapter)', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [{ id: 'gemini-sub', provider: 'google', auth: 'oauth', base_url: 'https://gen-lang.example.com/v1beta/openai', models: { 'Code-Max': 'gemini-pro' } }],
    db,
  });
  delete env.AIG_OAUTH_PROVIDERS; // built-in google default
  // Even a validly stored token must not dispatch: the google subscription
  // adapter refuses (no verified Gemini subscription backend exists behind
  // the OpenAI-compatible profile).
  await storeSubscriptionToken(env, { nodeId: 'gemini-sub', provider: 'google', accessToken: 'valid-token', refreshToken: 'g-refresh', expiresAt: Date.now() + 3600_000 });
  let upstreamContacted = false;
  withMockFetch(async () => {
    upstreamContacted = true;
    throw new Error('upstream must not be contacted');
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 502, 'dispatch fails closed to exhaustion');
  assert.equal(upstreamContacted, false);
});

// ---- P1: refresh singleflight, CAS rotation, account identity ---------------

const { resolveSubscriptionCredential, REFRESH_MARGIN_MS: MARGIN } = await import('../src/oauth/resolve.ts');
const { persistRefreshedToken } = await import('../src/oauth/token-store.ts');

function tier2OAuthRuntimeNode(id, provider = 'mock') {
  return {
    id, tier: 'tier-2', provider, protocol: 'openai', surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`, credential: '', priority: 100,
    models: { 'Code-Max': 'up-model' }, auth: 'oauth',
  };
}

await test('singleflight: 100 concurrent resolves issue exactly one refresh', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ db });
  await storeSubscriptionToken(env, {
    nodeId: 'sf-1', provider: 'mock', accessToken: 'stale', refreshToken: 'rt-1',
    expiresAt: Date.now() - 1000,
  });
  let refreshCalls = 0;
  withMockFetch(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'auth.mock.example.com') {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify({ access_token: 'fresh-sf', refresh_token: 'rt-2', expires_in: 3600 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected: ${url}`);
  });
  const node = tier2OAuthRuntimeNode('sf-1');
  const results = await Promise.all(Array.from({ length: 100 }, () => resolveSubscriptionCredential(env, node)));
  assert.equal(refreshCalls, 1, 'exactly one refresh in the isolate');
  assert.ok(results.every((r) => r.ok && r.token === 'fresh-sf'));
  const stored = await loadSubscriptionToken(env, 'sf-1');
  assert.equal(stored.refreshVersion, 1, 'CAS winner persisted version 1');
  assert.equal(stored.refreshToken, 'rt-2');
});

await test('CAS: a stale refresh writer loses and never clobbers the rotated token', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ db });
  await storeSubscriptionToken(env, {
    nodeId: 'cas-1', provider: 'mock', accessToken: 'old', refreshToken: 'rt-1',
    expiresAt: Date.now() - 1000,
  });
  withMockFetch(async () => new Response(JSON.stringify({ access_token: 'winner', refresh_token: 'rt-2', expires_in: 3600 }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  const node = tier2OAuthRuntimeNode('cas-1');
  const resolved = await resolveSubscriptionCredential(env, node);
  assert.ok(resolved.ok && resolved.token === 'winner');
  // A stale writer that loaded version 0 AFTER the winner persisted version 1.
  const stalePersist = await persistRefreshedToken(env, {
    nodeId: 'cas-1', accessToken: 'loser', refreshToken: 'rt-stale',
    expiresAt: Date.now() + 3600_000, expectedVersion: 0,
  });
  assert.equal(stalePersist, false, 'stale CAS write rejected');
  const stored = await loadSubscriptionToken(env, 'cas-1');
  assert.equal(stored.refreshVersion, 1, 'winner version untouched');
  assert.equal(stored.accessToken, 'winner');
  assert.equal(stored.refreshToken, 'rt-2', 'rotated RT2 remains the single authority');
});

await test('account_id from token exchange is persisted and sent as chatgpt-account-id for openai nodes', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [{ id: 'codex-sub', provider: 'openai', auth: 'oauth', base_url: 'https://codex-sub.example.com/v1', models: { 'Code-Max': 'gpt-codex' } }],
    db,
  });
  delete env.AIG_OAUTH_PROVIDERS; // built-in openai default (auth.openai.com, automatic)
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'auth.openai.com') {
      return new Response(JSON.stringify({
        access_token: 'codex-access', refresh_token: 'codex-refresh',
        expires_in: 3600, account_id: 'acct-12345',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.hostname === 'codex-sub.example.com') {
      const acct = init?.headers?.get('chatgpt-account-id');
      assert.equal(acct, 'acct-12345', 'chatgpt-account-id header applied');
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected: ${url}`);
  });

  const start = await worker.fetch(new Request('https://gateway.example.com/oauth/start?provider=openai&node=codex-sub', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(start.status, 302, 'openai default is an automatic redirect flow');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = await worker.fetch(new Request(
    `https://gateway.example.com/oauth/callback/openai?code=c&state=${encodeURIComponent(state)}`,
  ), env, {});
  assert.equal(callback.status, 200);
  const stored = await loadSubscriptionToken(env, 'codex-sub');
  assert.equal(stored.accountId, 'acct-12345', 'account_id persisted in plaintext');

  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
});

await test('non-openai oauth nodes never send chatgpt-account-id', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [tier2OauthNode('an-sub', 'anthropic', { base_url: 'https://an-sub.example.com' })],
    db,
  });
  await storeSubscriptionToken(env, {
    nodeId: 'an-sub', provider: 'anthropic', accessToken: 'tok', refreshToken: null,
    accountId: 'acct-should-not-send', expiresAt: Date.now() + 3600_000,
  });
  let sawAccountHeader = false;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'an-sub.example.com') {
      sawAccountHeader = !!init?.headers?.get('chatgpt-account-id');
      return new Response(JSON.stringify({
        type: 'message', role: 'assistant', model: 'up-model',
        content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected: ${url}`);
  });
  const messagesReq = new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify({ model: 'Code-Max', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const res = await worker.fetch(messagesReq, env, {});
  assert.equal(res.status, 200);
  assert.equal(sawAccountHeader, false, 'chatgpt-account-id is an OpenAI subscription header only');
});

await test('oauth node with an unknown provider fails closed (no subscription adapter)', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({ tier2: [tier2OauthNode('mystery-sub')], db });
  await storeSubscriptionToken(env, {
    nodeId: 'mystery-sub', provider: 'mock', accessToken: 'tok', refreshToken: null,
    expiresAt: Date.now() + 3600_000,
  });
  let upstreamContacted = false;
  withMockFetch(async () => {
    upstreamContacted = true;
    throw new Error('upstream must not be contacted');
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 502, 'no adapter -> fail-closed rotation to exhaustion');
  assert.equal(upstreamContacted, false);
});

// ---- P3: Codex subscription protocol normalization -----------------------------

await test('codex oauth dispatch sends Originator and normalizes empty instructions on responses', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [{ id: 'codex-sub', provider: 'openai', auth: 'oauth', base_url: 'https://codex-up.example.com', models: { 'Code-Max': 'gpt-codex' } }],
    db,
  });
  delete env.AIG_OAUTH_PROVIDERS;
  await storeSubscriptionToken(env, {
    nodeId: 'codex-sub', provider: 'openai', accessToken: 'codex-tok', refreshToken: null,
    accountId: 'acct-xyz', expiresAt: Date.now() + 3600_000,
  });
  let seenOriginator = null;
  let seenBody = null;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'codex-up.example.com') {
      seenOriginator = init?.headers?.get('originator');
      seenBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({
        id: 'resp_1', object: 'response', created_at: 1, status: 'completed',
        model: 'gpt-codex', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected: ${url}`);
  });
  const responsesRequest = new Request('https://gateway.example.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ model: 'Code-Max', input: 'hi' }), // no instructions field
  });
  const res = await worker.fetch(responsesRequest, env, {});
  assert.equal(res.status, 200);
  assert.equal(seenOriginator, 'codex-tui', 'Originator header applied');
  assert.equal(seenBody.instructions, '', 'instructions normalized to empty string when absent');
  assert.equal(seenBody.model, 'gpt-codex');
});

await test('codex oauth responses with client instructions are preserved', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [{ id: 'codex-sub', provider: 'openai', auth: 'oauth', base_url: 'https://codex-up.example.com', models: { 'Code-Max': 'gpt-codex' } }],
    db,
  });
  delete env.AIG_OAUTH_PROVIDERS;
  await storeSubscriptionToken(env, {
    nodeId: 'codex-sub', provider: 'openai', accessToken: 'codex-tok', refreshToken: null,
    expiresAt: Date.now() + 3600_000,
  });
  let seenBody = null;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'codex-up.example.com') {
      seenBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({
        id: 'resp_1', object: 'response', created_at: 1, status: 'completed',
        model: 'gpt-codex', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected: ${url}`);
  });
  const responsesRequest = new Request('https://gateway.example.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ model: 'Code-Max', input: 'hi', instructions: 'custom system prompt' }),
  });
  const res = await worker.fetch(responsesRequest, env, {});
  assert.equal(res.status, 200);
  assert.equal(seenBody.instructions, 'custom system prompt', 'client instructions preserved');
});

await test('plain API-key responses nodes are not codex-normalized', async () => {
  const env = makeEnv({
    tier1: [{ id: 'plain-resp', provider: 'openai', base_url: 'https://plain-up.example.com', models: { 'Code-Max': 'gpt-x' } }],
    extraEnv: { AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'plain-resp': 'sk-plain' }) },
  });
  let seenBody = null; let seenOriginator = null;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'plain-up.example.com') {
      seenBody = JSON.parse(String(init?.body || '{}'));
      seenOriginator = init?.headers?.get('originator');
      return new Response(JSON.stringify({
        id: 'resp_1', object: 'response', created_at: 1, status: 'completed',
        model: 'gpt-x', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected: ${url}`);
  });
  const responsesRequest = new Request('https://gateway.example.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ model: 'Code-Max', input: 'hi' }),
  });
  const res = await worker.fetch(responsesRequest, env, {});
  assert.equal(res.status, 200);
  assert.equal(seenBody.instructions, undefined, 'instructions not injected for API-key nodes');
  assert.equal(seenOriginator, null, 'Originator not sent for API-key nodes');
});

// ---- P3: Claude OAuth mainstream reverse-proxy shape ------------------------

function anthropicMessagesRequest(extraHeaders = {}) {
  return new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY, ...extraHeaders },
    body: JSON.stringify({ model: 'Code-Max', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

const anthropicUpstreamOk = () => new Response(JSON.stringify({
  type: 'message', role: 'assistant', model: 'up-model',
  content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

await test('claude oauth dispatch without client beta gets required oauth beta flags', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [{ id: 'claude-sub', provider: 'anthropic', auth: 'oauth', base_url: 'https://claude-up.example.com', models: { 'Code-Max': 'claude-sonnet-4-5' } }],
    db,
  });
  delete env.AIG_OAUTH_PROVIDERS;
  await storeSubscriptionToken(env, {
    nodeId: 'claude-sub', provider: 'anthropic', accessToken: 'claude-tok', refreshToken: null,
    expiresAt: Date.now() + 3600_000,
  });
  let seenBeta = null; let seenXApp = null; let seenUa = null;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'claude-up.example.com') {
      seenBeta = init?.headers?.get('anthropic-beta');
      seenXApp = init?.headers?.get('x-app');
      seenUa = init?.headers?.get('user-agent');
      return anthropicUpstreamOk();
    }
    throw new Error(`unexpected: ${url}`);
  });
  const res = await worker.fetch(anthropicMessagesRequest(), env, {});
  assert.equal(res.status, 200);
  assert.ok(seenBeta.includes('oauth-2025-04-20'), 'oauth beta flag present');
  assert.ok(seenBeta.includes('claude-code-20250219'), 'claude-code beta flag present');
  assert.equal(seenXApp, 'cli');
  assert.ok(seenUa.startsWith('claude-cli/'), 'first-party claude-cli user agent');
});

await test('claude oauth dispatch merges client betas without duplicates', async () => {
  const db = new MockOAuthD1();
  const env = makeEnv({
    tier2: [{ id: 'claude-sub', provider: 'anthropic', auth: 'oauth', base_url: 'https://claude-up.example.com', models: { 'Code-Max': 'claude-sonnet-4-5' } }],
    db,
  });
  delete env.AIG_OAUTH_PROVIDERS;
  await storeSubscriptionToken(env, {
    nodeId: 'claude-sub', provider: 'anthropic', accessToken: 'claude-tok', refreshToken: null,
    expiresAt: Date.now() + 3600_000,
  });
  let seenBeta = null;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'claude-up.example.com') {
      seenBeta = init?.headers?.get('anthropic-beta');
      return anthropicUpstreamOk();
    }
    throw new Error(`unexpected: ${url}`);
  });
  const res = await worker.fetch(anthropicMessagesRequest({
    'anthropic-beta': 'token-counting-2024-11-01,oauth-2025-04-20',
  }), env, {});
  assert.equal(res.status, 200);
  const betas = seenBeta.split(',').map((s) => s.trim());
  assert.ok(betas.includes('token-counting-2024-11-01'), 'client beta preserved');
  assert.ok(betas.includes('claude-code-20250219'), 'required beta appended');
  assert.equal(betas.filter((b) => b === 'oauth-2025-04-20').length, 1, 'no duplicate oauth beta');
  assert.ok(betas.includes('interleaved-thinking-2025-05-14'));
});

await test('plain API-key anthropic nodes get no forced oauth betas', async () => {
  const env = makeEnv({
    tier1: [{ id: 'claude-key', provider: 'anthropic', base_url: 'https://claude-key.example.com', models: { 'Code-Max': 'claude-sonnet-4-5' } }],
    extraEnv: { AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'claude-key': 'sk-ant-key' }) },
  });
  let seenBeta = null; let seenXApp = null;
  withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'claude-key.example.com') {
      seenBeta = init?.headers?.get('anthropic-beta');
      seenXApp = init?.headers?.get('x-app');
      return anthropicUpstreamOk();
    }
    throw new Error(`unexpected: ${url}`);
  });
  const res = await worker.fetch(anthropicMessagesRequest(), env, {});
  assert.equal(res.status, 200);
  assert.equal(seenBeta, null, 'no forced betas for API-key nodes');
  assert.equal(seenXApp, null, 'no x-app for API-key nodes');
});

console.log(`\nAll OAuth tests: ${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
