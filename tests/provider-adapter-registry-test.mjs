#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Provider adapter registry contracts:
//   - registered providers resolve to their adapter (wire, quirks,
//     OAuth defaults, subscription semantics)
//   - unknown providers resolve to the generic OpenAI-compatible adapter
//   - adding a plain OpenAI-compatible provider is configuration-only
//     (no registry entry, no source change) and never regresses routing
//   - subscription dispatchability fails closed for providers without a
//     verified subscription backend
//   - adapter-declared OAuth defaults feed the AIG_OAUTH_PROVIDERS merge

import assert from 'node:assert/strict';
import { loadGatewayConfig } from '../src/config/nodes.ts';
import { __resetOAuthProvidersCacheForTests, loadOAuthProviders } from '../src/oauth/provider-configs.ts';
import { builtinOAuthProviderConfigs, getProviderAdapter, providerWire, streamUsageEnabled } from '../src/providers/registry.ts';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e?.stack || e);
    process.exitCode = 1;
  }
}

function envFor(nodes) {
  return {
    AIG_ACCESS_KEY_AIR: 'k',
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_TIER1_NODES_01: JSON.stringify(nodes),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, 'x']))),
  };
}
const rawNode = (id, provider) => ({
  id,
  provider,
  base_url: `https://${id}.example.com/v1`,
  models: { 'general-air': 'up-model' },
});

test('registered providers keep their exact native wire contracts', () => {
  assert.deepEqual(providerWire('openai'), { protocol: 'openai', surfaces: ['chat_completions', 'responses'] });
  assert.deepEqual(providerWire('anthropic'), { protocol: 'anthropic', surfaces: ['messages'] });
  assert.deepEqual(providerWire('google'), { protocol: 'openai', surfaces: ['chat_completions'] });
  assert.equal(getProviderAdapter('openai').id, 'openai');
  assert.equal(getProviderAdapter('anthropic').id, 'anthropic');
  assert.equal(getProviderAdapter('google').id, 'google');
});

test('provider names resolve case-insensitively and whitespace-tolerantly', () => {
  assert.equal(getProviderAdapter(' OpenAI ').id, 'openai');
  assert.equal(getProviderAdapter('Anthropic').id, 'anthropic');
});

test('unknown providers resolve to the generic OpenAI-compatible adapter', () => {
  const adapter = getProviderAdapter('xyz-provider');
  assert.equal(adapter.id, 'generic-openai');
  assert.deepEqual(adapter.wire, { protocol: 'openai', surfaces: ['chat_completions'] });
  assert.equal(adapter.streamUsage, true);
  assert.equal(adapter.subscription, undefined);
  assert.equal(adapter.oauth, undefined);
  assert.deepEqual(providerWire(''), { protocol: 'openai', surfaces: ['chat_completions'] });
});

test('scenario: a plain OpenAI-compatible provider is configuration-only', () => {
  const cfg = loadGatewayConfig(envFor([rawNode('xyz-01', 'xyz-provider')]));
  assert.equal(cfg.status, 'ready');
  assert.equal(cfg.nodes[0].provider, 'xyz-provider');
  assert.equal(cfg.nodes[0].protocol, 'openai');
  assert.deepEqual(cfg.nodes[0].surfaces, ['chat_completions']);
  // And it has no subscription semantics: a Tier 2 auth:"oauth" node for
  // it would fail closed at dispatch instead of half-shaping a request.
  assert.equal(getProviderAdapter('xyz-provider').subscription, undefined);
});

test('node config wire derivation matches the registry for every provider class', () => {
  for (const provider of ['openai', 'anthropic', 'google', 'xyz-provider']) {
    const cfg = loadGatewayConfig(envFor([rawNode(`${provider}-n`, provider)]));
    const node = cfg.nodes.find((n) => n.provider === provider);
    assert.equal(node.protocol, providerWire(provider).protocol, `${provider} protocol`);
    assert.deepEqual(node.surfaces, [...providerWire(provider).surfaces], `${provider} surfaces`);
  }
});

test('google shapes Code Assist subscription requests and declares a proprietary wire', () => {
  const adapter = getProviderAdapter('google').subscription;
  assert.ok(adapter, 'google must expose its subscription adapter');
  assert.ok(adapter.wire, 'google declares a proprietary subscription wire');
  assert.equal(typeof adapter.wire.streamToNative, 'function');
  assert.equal(typeof adapter.wire.objectToNative, 'function');
  const prepared = adapter.prepare({
    node: {
      id: 'g',
      tier: 'tier-2',
      provider: 'google',
      protocol: 'openai',
      surfaces: ['chat_completions'],
      baseUrl: 'https://cloudcode-pa.googleapis.com',
      credential: '',
      priority: 10,
      models: {},
      auth: 'oauth',
    },
    credential: { ok: true, token: 't', accountId: null },
    request: new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST' }),
    body: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] },
    surface: 'chat_completions',
  });
  assert.ok(prepared, 'google shapes a valid chat request');
  assert.ok(prepared.upstreamUrl.includes('/v1internal:generateContent'), 'non-stream path');
  assert.ok(prepared.headers['user-agent'].startsWith('GeminiCLI/'), 'first-party Gemini CLI user agent');
  assert.equal(prepared.body.model, 'gemini-2.5-pro');
  assert.ok(prepared.body.request.contents);
  // Streaming request selects the streaming endpoint.
  const streamed = adapter.prepare({
    node: {
      id: 'g',
      tier: 'tier-2',
      provider: 'google',
      protocol: 'openai',
      surfaces: ['chat_completions'],
      baseUrl: 'https://cloudcode-pa.googleapis.com',
      credential: '',
      priority: 10,
      models: {},
      auth: 'oauth',
    },
    credential: { ok: true, token: 't', accountId: null },
    request: new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST' }),
    body: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    surface: 'chat_completions',
  });
  assert.ok(streamed.upstreamUrl.includes('/v1internal:streamGenerateContent'), 'stream path');
  assert.ok(streamed.upstreamUrl.includes('alt=sse'), 'sse query preserved');
  assert.equal(streamed.headers.accept, 'text/event-stream');
});

test('google subscription adapter refuses unsupported surfaces and bodies (fail-closed)', () => {
  const adapter = getProviderAdapter('google').subscription;
  const node = {
    id: 'g',
    tier: 'tier-2',
    provider: 'google',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    credential: '',
    priority: 10,
    models: {},
    auth: 'oauth',
  };
  const cred = { ok: true, token: 't', accountId: null };
  const request = new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST' });
  // Responses surface: google Code Assist has one chat surface only.
  assert.equal(
    adapter.prepare({ node, credential: cred, request, body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, surface: 'responses' }),
    null,
  );
  // Unsupported request body (no messages): fail-closed rotation.
  assert.equal(adapter.prepare({ node, credential: cred, request, body: { model: 'm' }, surface: 'chat_completions' }), null);
  // Unresolved credential: fail-closed rotation.
  assert.equal(
    adapter.prepare({
      node,
      credential: { ok: false, reason: 'no_token' },
      request,
      body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      surface: 'chat_completions',
    }),
    null,
  );
});

test('openai and anthropic adapters keep their subscription semantics', () => {
  const codex = getProviderAdapter('openai').subscription;
  assert.ok(codex, 'openai must expose its codex subscription adapter');
  const claude = getProviderAdapter('anthropic').subscription;
  assert.ok(claude, 'anthropic must expose its claude subscription adapter');

  const codexPrepared = codex.prepare({
    node: {
      id: 'o',
      tier: 'tier-2',
      provider: 'openai',
      protocol: 'openai',
      surfaces: ['chat_completions', 'responses'],
      baseUrl: 'https://o.example.com',
      credential: '',
      priority: 10,
      models: {},
      auth: 'oauth',
    },
    credential: { ok: true, token: 't', accountId: 'acct-1' },
    request: new Request('https://gateway.example.com/v1/responses', { method: 'POST' }),
    body: { model: 'm' },
    surface: 'responses',
  });
  assert.equal(codexPrepared.headers.Originator, 'codex-tui');
  assert.equal(codexPrepared.headers['chatgpt-account-id'], 'acct-1');
  assert.equal(codexPrepared.body.instructions, '');

  const claudePrepared = claude.prepare({
    node: {
      id: 'a',
      tier: 'tier-2',
      provider: 'anthropic',
      protocol: 'anthropic',
      surfaces: ['messages'],
      baseUrl: 'https://a.example.com',
      credential: '',
      priority: 10,
      models: {},
      auth: 'oauth',
    },
    credential: { ok: true, token: 't', accountId: null },
    request: new Request('https://gateway.example.com/v1/messages', { method: 'POST', headers: { 'anthropic-beta': 'claude-code-20250219' } }),
    body: { model: 'm' },
    surface: 'messages',
  });
  assert.ok(claudePrepared.headers['anthropic-beta'].includes('oauth-2025-04-20'));
  assert.equal(claudePrepared.headers['x-app'], 'cli');
});

test('subscription adapters keep their quota-reset hint semantics', () => {
  const now = Date.now();
  const codexHint = getProviderAdapter('openai').subscription.quotaResetHint(
    {
      status: 429,
      headers: new Headers({ 'x-codex-primary-used-window-reset': String(Math.floor(now / 1000) + 1800) }),
      body: '',
    },
    now,
  );
  assert.ok(codexHint !== null && Math.abs(codexHint - 1800 * 1000) < 5000, 'codex window-reset header must produce a ~30m cooldown hint');

  const claudeHint = getProviderAdapter('anthropic').subscription.quotaResetHint(
    {
      status: 429,
      headers: new Headers({ 'anthropic-ratelimit-requests-reset': '900' }),
      body: '',
    },
    now,
  );
  assert.equal(claudeHint, 900 * 1000);

  const googleRetryHint = getProviderAdapter('google').subscription.quotaResetHint(
    {
      status: 429,
      headers: new Headers(),
      body: JSON.stringify({
        error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' }] },
      }),
    },
    now,
  );
  assert.equal(googleRetryHint, 42 * 1000, 'google gRPC retryDelay produces a cooldown hint');

  const googleRetryAfterHint = getProviderAdapter('google').subscription.quotaResetHint(
    {
      status: 429,
      headers: new Headers({ 'retry-after': '60' }),
      body: '',
    },
    now,
  );
  assert.equal(googleRetryAfterHint, 60 * 1000, 'google Retry-After header produces a cooldown hint');

  const noHint = getProviderAdapter('openai').subscription.quotaResetHint(
    {
      status: 500,
      headers: new Headers(),
      body: '',
    },
    now,
  );
  assert.equal(noHint, null, 'quota hints only apply to rate-limit responses');
});

test('streamUsageEnabled keeps the operator override ladder', () => {
  const openaiNode = { provider: 'openai', protocol: 'openai', surfaces: ['chat_completions', 'responses'] };
  const anthropicNode = { provider: 'anthropic', protocol: 'anthropic', surfaces: ['messages'] };
  const genericNode = { provider: 'xyz-provider', protocol: 'openai', surfaces: ['chat_completions'] };

  assert.equal(streamUsageEnabled(openaiNode, {}), true, 'auto: openai chat streams ask for usage');
  assert.equal(streamUsageEnabled(anthropicNode, {}), false, 'auto: anthropic never asks');
  assert.equal(streamUsageEnabled(genericNode, {}), true, 'auto: generic openai-compatible asks');
  assert.equal(streamUsageEnabled(openaiNode, { AIG_USAGE_INCLUDE_MODE: 'off' }), false, 'global kill switch');
  assert.equal(streamUsageEnabled(anthropicNode, { AIG_USAGE_INCLUDE_MODE: 'on' }), true, 'global force switch');
  assert.equal(streamUsageEnabled(openaiNode, { AIG_USAGE_EXCLUDE_PROVIDERS: 'OpenAI' }), false, 'per-provider off-list');
  assert.equal(
    streamUsageEnabled({ provider: 'openai', protocol: 'openai', surfaces: ['responses'] }, {}),
    false,
    'a node whose surfaces lack chat_completions never asks',
  );
});

test('adapter-declared OAuth defaults feed loadOAuthProviders', () => {
  __resetOAuthProvidersCacheForTests();
  const defaults = loadOAuthProviders({});
  assert.equal(defaults.anthropic.authorizeUrl, 'https://claude.ai/oauth/authorize');
  assert.equal(defaults.anthropic.clientId, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.equal(defaults.openai.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(defaults.openai.scope, 'openid email profile offline_access');
  assert.equal(defaults.google.clientSecret, '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');
  assert.equal(defaults.google.manualRedirectUrl, 'https://codeassist.google.com/authcode');
  assert.deepEqual(Object.keys(defaults).sort(), ['anthropic', 'google', 'openai']);
  assert.deepEqual(builtinOAuthProviderConfigs(), {
    openai: defaults.openai,
    anthropic: defaults.anthropic,
    google: defaults.google,
  });
});

test('built-in subscription endpoints let Tier 2 oauth nodes omit base_url', () => {
  assert.equal(getProviderAdapter('google').subscriptionEndpoint, 'https://cloudcode-pa.googleapis.com');
  assert.equal(getProviderAdapter('anthropic').subscriptionEndpoint, 'https://api.anthropic.com');
  assert.equal(getProviderAdapter('openai').subscriptionEndpoint, 'https://api.openai.com');
});

test('AIG_OAUTH_PROVIDERS still replaces defaults wholesale and adds custom providers', () => {
  __resetOAuthProvidersCacheForTests();
  const custom = {
    anthropic: {
      authorize_url: 'https://custom.example.com/authorize',
      token_url: 'https://custom.example.com/token',
      client_id: 'custom-client',
      scope: 'custom-scope',
    },
    'acme-sub': {
      authorize_url: 'https://acme.example.com/authorize',
      token_url: 'https://acme.example.com/token',
      client_id: 'acme-client',
      scope: 'acme-scope',
    },
  };
  const merged = loadOAuthProviders({ AIG_OAUTH_PROVIDERS: JSON.stringify(custom) });
  assert.equal(merged.anthropic.authorizeUrl, 'https://custom.example.com/authorize');
  assert.equal(merged.anthropic.clientId, 'custom-client');
  assert.equal(merged.openai.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann', 'untouched providers keep their defaults');
  assert.equal(merged['acme-sub'].clientId, 'acme-client', 'operator-added providers enter the OAuth registry');
  assert.equal(getProviderAdapter('acme-sub').subscription, undefined, 'operator-added providers fail closed for subscription dispatch');
  __resetOAuthProvidersCacheForTests();
});

console.log(`[provider-adapter-registry-test] ${passed} checks passed`);
