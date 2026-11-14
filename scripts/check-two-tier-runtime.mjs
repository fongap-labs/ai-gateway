#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Strict two-Tier source/runtime contract. No network, credentials or deployment.

import assert from 'node:assert/strict';
import { recordOutcome } from '../apps/gateway/attempt/outcome.ts';
import { buildModelFallbackPlan, buildModelFallbackRounds } from '../apps/gateway/policy/model-fallback.ts';
import { TIER_ORDER } from '../apps/gateway/policy/router.ts';
import { preflight } from '../apps/gateway/preflight.ts';
import { handleRequest } from '../apps/gateway/request-handler.ts';
import { buildExhaustedResponse } from '../apps/gateway/response/errors.ts';
import { hasConfirmedUpstreamFailure } from '../apps/gateway/response/failover-evidence.ts';
import { redistributeUnusedTierAttempts } from '../apps/gateway/scheduling/tier-policy.ts';
import { getModelsConfigDiagnostics, loadModelsConfig } from '../src/config/models.ts';
import { loadExecutionConfig, loadGatewayConfig } from '../src/config/nodes.ts';
import { getPoliciesConfigDiagnostics } from '../src/config/policies.ts';
import { getLimits } from '../src/config/timeouts.ts';
import { metricsResponse } from '../src/observability/diagnostic-endpoints.ts';
import { __resetBodyBudgetForTests, admitRequestBody } from '../src/ratelimit/body-budget.ts';
import { __resetIsolateConcurrencyForTests, snapshotIsolateRequestActivity } from '../src/ratelimit/isolate-concurrency.ts';
import { __resetKeyRpmForTests, admitAuthAttempt, admitKeyRequest, getKeyRpmSnapshot, recordAuthFailure } from '../src/ratelimit/key-rpm.ts';
import { getNodeState } from '../src/reliability/node-state.ts';
import {
  __resetSharedTier1CooldownsForTests,
  hydrateSharedTier1Cooldowns,
  shareLongTier1Cooldowns,
  snapshotSharedTier1Cooldowns,
} from '../src/reliability/tier1-shared-cooldowns.ts';
import { __resetTier1StateForTests, adoptTier1Cooldown } from '../src/reliability/tier1-state.ts';
import { routingStrategyFor } from '../src/scheduler/routing-strategy.ts';
import { collectSecretsFromEnv, collectVarsFromEnv, normalizeRuntimeConfig } from './github-deployment-config.mjs';

// Cost protection changes only defaults, never an operator's explicit choice.
// Global delivered-success and usage-coverage evidence remains unsampled.
assert.equal(getLimits({}).tokenD1SamplePct, 100);
assert.equal(getLimits({ AIG_COST_GUARDS: 'false' }).tokenD1SamplePct, 100);
assert.equal(getLimits({ AIG_COST_GUARDS: 'true' }).tokenD1SamplePct, 1);
assert.equal(getLimits({ AIG_COST_GUARDS: 'true', AIG_TOKEN_D1_SAMPLE_PCT: '0' }).tokenD1SamplePct, 0);
assert.equal(getLimits({ AIG_COST_GUARDS: 'true', AIG_TOKEN_D1_SAMPLE_PCT: '37' }).tokenD1SamplePct, 37);
assert.equal(getLimits({ AIG_COST_GUARDS: 'true', AIG_TOKEN_D1_SAMPLE_PCT: '100' }).tokenD1SamplePct, 100);
assert.equal(getLimits({ AIG_COST_GUARDS: 'false', AIG_TOKEN_D1_SAMPLE_PCT: '37' }).tokenD1SamplePct, 37);
assert.equal(getLimits({ AIG_COST_GUARDS: 'true' }).tier1AffinityWrite, false);
assert.equal(getLimits({ AIG_COST_GUARDS: 'true', AIG_AFFINITY_WRITE: '1' }).tier1AffinityWrite, true);

assert.equal(
  getLimits({ AIG_REQUEST_ADMISSION: 'true' }).isolateMaxInFlight,
  0,
  'request-body guards must not impose a hidden concurrent-request count',
);
assert.equal(
  getLimits({ AIG_REQUEST_ADMISSION: 'true', AIG_ISOLATE_MAX_IN_FLIGHT: '4' }).isolateMaxInFlight,
  4,
  'the historical numeric setting remains parsed for deployment compatibility, but cannot deny requests',
);
assert.deepEqual(TIER_ORDER, [1, 2], 'only free and API Token tiers participate in routing');
assert.equal(routingStrategyFor(1).id, 'p2c_ttft', 'the free tier retains its adaptive scheduler');
assert.equal(routingStrategyFor(2).id, 'priority_lru', 'the API Token tier uses the health-aware scheduler');

const originalCaps = { 1: 3, 2: 1 };
const flexiblePolicy = { maxAttempts: 5, tierAttempts: null };
assert.deepEqual(
  redistributeUnusedTierAttempts({ ...originalCaps }, 1, 2, flexiblePolicy),
  { 1: 3, 2: 3 },
  'unused free-tier attempts transfer to the paid API Token reserve',
);
assert.deepEqual(
  redistributeUnusedTierAttempts({ ...originalCaps }, 1, 2, { maxAttempts: 5, tierAttempts: { tier2: 1 } }),
  originalCaps,
  'explicit Token tier attempt caps are never relaxed',
);
assert.deepEqual(
  redistributeUnusedTierAttempts({ ...originalCaps }, 2, 2, flexiblePolicy),
  originalCaps,
  'Token tier is terminal; no third tier can receive unused attempts',
);

// v0.1.5 family behavior, expressed through opaque model configuration:
// one-way upward fallback never returns; interchangeable models get two rounds.
const fallbackModels = {
  entry: { policy: { fallback: ['middle', 'high', 'last'] } },
  middle: { policy: { fallback: ['high', 'last'] } },
  high: { policy: { fallback: ['middle', 'last'] } },
  last: { policy: { fallback: ['middle', 'high'] } },
};
const fallbackCatalog = new Set(Object.keys(fallbackModels));
assert.deepEqual(
  buildModelFallbackRounds('entry', fallbackCatalog, fallbackModels),
  [
    ['entry', 'middle', 'high', 'last'],
    ['middle', 'high', 'last'],
  ],
  'one-way model fallback never returns to its origin',
);
assert.deepEqual(
  buildModelFallbackRounds('middle', fallbackCatalog, fallbackModels),
  [
    ['middle', 'high', 'last'],
    ['middle', 'high', 'last'],
  ],
  'reversible model fallback rechecks the requested model like v0.1.5',
);
assert.deepEqual(
  buildModelFallbackPlan('entry', fallbackCatalog, 6, fallbackModels)[0].map((step) => step.attemptCap),
  [3, 1, 1, 1],
  'one-way family retains v0.1.5 cap allocation',
);
assert.deepEqual(
  buildModelFallbackPlan('middle', fallbackCatalog, 6, fallbackModels)[0].map((step) => step.attemptCap),
  [3, 2, 1],
  'interchangeable family retains v0.1.5 3/2/1 allocation',
);

// The three-member v0.1.5 fallback family remains revisitable even when
// downstream model aliases are not configured to return to the source.
const nonReciprocal = {
  source: { policy: { fallback: ['peer-a', 'peer-b'], fallback_mode: 'recheck' } },
  'peer-a': { policy: { fallback: [] } },
  'peer-b': { policy: { fallback: [] } },
};
assert.deepEqual(
  buildModelFallbackRounds('source', new Set(Object.keys(nonReciprocal)), nonReciprocal),
  [
    ['source', 'peer-a', 'peer-b'],
    ['source', 'peer-a', 'peer-b'],
  ],
  'three-member families retain v0.1.5 recheck behavior without naming assumptions',
);
assert.deepEqual(
  buildModelFallbackPlan('source', new Set(Object.keys(nonReciprocal)), 6, nonReciprocal)[0].map((pass) => pass.attemptCap),
  [3, 2, 1],
  'three-member families retain v0.1.5 attempt shares',
);

// Model count and spelling never decide one-way vs recheck. Explicit policy
// overrides graph-derived defaults, and attempt caps stay per-model config.
const sameGraph = {
  start: { policy: { fallback: ['leaf-a', 'leaf-b'] } },
  'leaf-a': { policy: { fallback: [] } },
  'leaf-b': { policy: { fallback: [] } },
};
assert.deepEqual(
  buildModelFallbackRounds('start', new Set(Object.keys(sameGraph)), sameGraph)[1],
  ['leaf-a', 'leaf-b'],
  'unidirectional configured edges do not imply reverse access',
);
sameGraph.start.policy.fallback_mode = 'recheck';
sameGraph.start.policy.fallback_attempt_caps = [2, 1, 3];
assert.deepEqual(
  buildModelFallbackRounds('start', new Set(Object.keys(sameGraph)), sameGraph)[1],
  ['start', 'leaf-a', 'leaf-b'],
  'explicit recheck works independent of family width and model name',
);
assert.deepEqual(
  buildModelFallbackPlan('start', new Set(Object.keys(sameGraph)), 6, sameGraph)[0].map((pass) => pass.attemptCap),
  [2, 1, 3],
  'configured caps override default order preferences without expanding request budget',
);
const parsedModelEnv = {
  AIG_MODELS_CONFIG: JSON.stringify({
    start: { fallback: ['leaf-a', 'leaf-b'], fallback_mode: 'recheck', fallback_attempt_caps: [2, 1, 3] },
    'leaf-a': {},
    'leaf-b': {},
  }),
};
const parsedModels = loadModelsConfig(parsedModelEnv);
assert.equal(getModelsConfigDiagnostics(parsedModelEnv).length, 0);
assert.equal(parsedModels.start?.policy.fallback_mode, 'recheck');
assert.deepEqual(parsedModels.start?.policy.fallback_attempt_caps, [2, 1, 3]);
for (const invalid of [
  { fallback: ['leaf-a'], fallback_mode: 'unexpected' },
  { fallback: ['leaf-a'], fallback_attempt_caps: [2, 0] },
  { fallback: ['leaf-a'], fallback_attempt_caps: [1] },
  { fallback_mode: 'one_way' },
]) {
  const env = { AIG_MODELS_CONFIG: JSON.stringify({ start: invalid, 'leaf-a': {} }) };
  assert.ok(getModelsConfigDiagnostics(env).length > 0, 'invalid fallback scheduling config must fail validation');
}

const CUTOVER_MODEL = 'cutover-contract-model';
const MOCK_UPSTREAM_MODEL = 'mock-upstream-model';

function node(id, fields = {}) {
  return { id, provider: 'openai', base_url: 'https://api.example.invalid/v1', models: { [CUTOVER_MODEL]: MOCK_UPSTREAM_MODEL }, ...fields };
}
const base = {
  AIG_ACCESS_KEY_AIR: 'local-contract-access-key',
  AIG_TIER1_NODES_01: JSON.stringify([node('free-a')]),
  AIG_TIER2_NODES_01: JSON.stringify([node('token-a')]),
};
const tier1Only = loadGatewayConfig({ AIG_ACCESS_KEY_AIR: base.AIG_ACCESS_KEY_AIR, AIG_TIER1_NODES_01: base.AIG_TIER1_NODES_01 });
assert.equal(tier1Only.ready, true, 'Tier 1-only config must stay ready without a paid fallback');
assert.equal(tier1Only.tiers[1].length, 1);
assert.equal(tier1Only.tiers[2].length, 0, 'unconfigured Tier 2 is absent, not a failure');
const publicConfig = loadGatewayConfig({ ...base });
assert.equal(publicConfig.ready, true);
assert.equal(publicConfig.hasConfigErrors, false);
assert.deepEqual(Object.keys(publicConfig.tiers).sort(), ['1', '2']);
assert.deepEqual(
  publicConfig.tiers[1].map((n) => n.id),
  ['free-a'],
);
assert.deepEqual(
  publicConfig.tiers[2].map((n) => n.id),
  ['token-a'],
);
const centerConfig = loadExecutionConfig({
  ...base,
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'free-a': 'free-test-credential' }),
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ 'token-a': 'paid-test-credential' }),
});
assert.equal(centerConfig.ready, true);
assert.equal(publicConfig.tiers[1][0]?.credential, '', 'public Gateway must not own free Provider credentials');
assert.equal(publicConfig.tiers[2][0]?.credential, '', 'public Gateway must not own paid Provider credentials');
assert.equal(centerConfig.tiers[2][0]?.credential, 'paid-test-credential', 'private center resolves the API Token credential');

const cacheKey = 'a'.repeat(32);
const deploymentInput = {
  vars: { AIG_TIER1_NODES_01: base.AIG_TIER1_NODES_01 },
  secrets: {
    AIG_ACCESS_KEY_AIR: base.AIG_ACCESS_KEY_AIR,
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({ 'free-a': 'free-test-credential' }),
    AIG_EDGE_CACHE_HMAC_KEY: cacheKey,
  },
};
assert.equal(normalizeRuntimeConfig(deploymentInput).secrets.AIG_EDGE_CACHE_HMAC_KEY, cacheKey);
assert.throws(
  () =>
    normalizeRuntimeConfig({
      ...deploymentInput,
      vars: { ...deploymentInput.vars, AIG_EDGE_CACHE_HMAC_KEY: cacheKey },
    }),
  /credentials belong in secrets/,
  'edge cache HMAC keys must never be published as Worker vars',
);
assert.equal(collectVarsFromEnv({ ...base, AIG_EDGE_CACHE_HMAC_KEY: cacheKey }).vars.AIG_EDGE_CACHE_HMAC_KEY, undefined);
assert.equal(collectSecretsFromEnv({ AIG_EDGE_CACHE_HMAC_KEY: cacheKey }).secrets.AIG_EDGE_CACHE_HMAC_KEY, cacheKey);
assert.deepEqual(
  centerConfig.tiers[2].map((n) => n.id),
  ['token-a'],
);

for (const oldBinding of ['AIG_TIER3_NODES_01', 'AIG_TIER3_CREDENTIALS_01']) {
  const env = { ...base, [oldBinding]: oldBinding.includes('NODES') ? '[]' : '{}' };
  const result = loadGatewayConfig(env);
  assert.equal(result.ready, false, 'legacy binding must reject the entire configuration');
  assert.equal(result.status, 'invalid');
  assert.equal(result.nodesUsable, 0);
  assert.ok(result.diagnostics.some((line) => line.includes('legacy Tier 3')));
}
for (const oldPolicy of [
  { default: { max_attempts: 4, tier_attempts: { tier1: 1, tier3: 2 } } },
  { default: { hedge: { enabled: true, tiers: ['tier3'] } } },
]) {
  const env = { ...base, AIG_POLICIES_CONFIG: JSON.stringify(oldPolicy) };
  const result = loadGatewayConfig(env);
  assert.equal(result.ready, false, 'legacy policy must fail closed, not run on a partial pool');
  assert.equal(result.status, 'invalid');
  assert.ok(getPoliciesConfigDiagnostics(env).length > 0);
}
const oldOAuth = loadGatewayConfig({
  ...base,
  AIG_TIER2_NODES_01: JSON.stringify([node('token-a'), node('subscription-a', { auth: 'oauth' })]),
});
assert.equal(oldOAuth.ready, false, 'old subscriber capacity must not be silently treated as an API Token');
assert.equal(oldOAuth.status, 'invalid');
assert.equal(oldOAuth.nodesUsable, 0);
assert.ok(oldOAuth.diagnostics.some((line) => line.includes('subscription auth marker')));
for (const [legacySetting, value] of [
  ['AIG_OAUTH_PROVIDERS', '{}'],
  ['AIG_IS_SUBSCRIPTION_ENABLED', 'false'],
  ['AIG_TOKEN_ENCRYPTION_KEY', 'fake-old-encryption-key'],
]) {
  const legacy = loadGatewayConfig({ ...base, [legacySetting]: value });
  assert.equal(legacy.status, 'invalid', `retired membership setting ${legacySetting} must fail closed`);
  assert.equal(legacy.nodesUsable, 0, 'membership settings must never leave partial API Token capacity serving');
  assert.ok(legacy.diagnostics.some((line) => line.includes(legacySetting)));
}

const oldPrivateSecrets = loadExecutionConfig({
  ...base,
  AIG_TIER2_CREDENTIALS_01: JSON.stringify({ 'token-a': 'new-token-only' }),
  AIG_TIER3_CREDENTIALS_01: JSON.stringify({ 'old-paid': 'fake-old-token' }),
});
assert.equal(oldPrivateSecrets.status, 'invalid', 'old paid credentials cannot be skipped by private-center load');
assert.equal(oldPrivateSecrets.nodesUsable, 0);

// The 404 guard must precede authorization, subscriptions and private-center
// execution. A retired OAuth callback must never exchange, refresh or persist
// tokens, even if an operator forgot to remove historical configuration.
for (const method of ['GET', 'POST']) {
  for (const uri of ['/oauth/start', '/oauth/callback', '/oauth/refresh']) {
    const request = new Request(`https://gateway.example.invalid${uri}`, { method });
    const terminal = await preflight(
      request,
      { ...base, AIG_OAUTH_PROVIDERS: '{}' },
      {
        waitUntil() {
          throw new Error('Legacy OAuth must not schedule work');
        },
      },
    );
    assert.equal(terminal.ok, false, `${method} ${uri} must terminate in Gateway`);
    assert.equal(terminal.response.status, 404, `${method} ${uri} must remain unavailable`);
    assert.equal(terminal.response.headers.get('set-cookie'), null, 'OAuth cookies must not be created');
  }
}

// An extra physical dispatch does not by itself prove failure recovery.
// A loser of a speculative hedge, a pre-dispatch refusal or an unrelated
// successful attempt must not advertise x-gateway-failover.
assert.equal(hasConfirmedUpstreamFailure([{ dispatched: true, status: 503, kind: 'server' }]), true);
assert.equal(hasConfirmedUpstreamFailure([{ dispatched: true, status: 0, kind: 'network' }]), true);
assert.equal(hasConfirmedUpstreamFailure([{ dispatched: false, status: 422, kind: 'client' }]), false);
assert.equal(hasConfirmedUpstreamFailure([{ dispatched: true, status: 0, kind: 'cancelled_after_peer_commit' }]), false);
assert.equal(hasConfirmedUpstreamFailure([{ dispatched: true, status: 0, kind: 'client_abort' }]), false);
assert.equal(hasConfirmedUpstreamFailure([{ dispatched: true, status: 200, kind: 'ok' }]), false);

const twoTierPolicy = {
  ...base,
  AIG_POLICIES_CONFIG: JSON.stringify({
    default: { max_attempts: 4, tier_attempts: { tier1: 2, tier2: 2 }, hedge: { enabled: true, tiers: ['tier1', 'tier2'] } },
  }),
};
assert.deepEqual(getPoliciesConfigDiagnostics(twoTierPolicy), []);
assert.equal(loadGatewayConfig(twoTierPolicy).ready, true);

async function verifyTier1FailureFallsBack(status) {
  const tier1Id = `free-${status}`;
  const tier2Id = `token-${status}`;
  const requestOrder = [];
  const env = {
    AIG_ACCESS_KEY_AIR: 'local-contract-access-key',
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_INFERENCE_AUTH_KEY: 'a'.repeat(32),
    AIG_TIER1_NODES_01: JSON.stringify([node(tier1Id)]),
    AIG_TIER2_NODES_01: JSON.stringify([node(tier2Id)]),
    AIG_MODELS_CONFIG: JSON.stringify({ [CUTOVER_MODEL]: { policy: 'default' } }),
    AIG_POLICIES_CONFIG: JSON.stringify({
      default: { max_attempts: 2, tier_attempts: { tier1: 1, tier2: 1 }, hedge: { enabled: false } },
    }),
    AIG_INFERENCE_SERVICE: {
      async fetch(request) {
        const id = request.headers.get('x-aig-node-id');
        requestOrder.push(id);
        if (id === tier1Id) {
          return new Response(JSON.stringify({ error: { message: 'mock transient failure' } }), {
            status,
            headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' },
          });
        }
        assert.equal(id, tier2Id, 'Only the configured Tier 2 Token may receive the fallback');
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: 1,
            model: CUTOVER_MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' } },
        );
      },
    },
  };
  const request = new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer local-contract-access-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: CUTOVER_MODEL, messages: [{ role: 'user', content: 'hello' }] }),
  });
  const response = await handleRequest(request, env, { waitUntil() {}, passThroughOnException() {} });
  const responseText = await response.text();
  assert.equal(response.status, 200, `Tier 2 must recover after Tier 1 returns ${status}: ${responseText}`);
  assert.deepEqual(requestOrder, [tier1Id, tier2Id], `Tier 1 ${status} must be followed by one Tier 2 dispatch`);
  assert.ok(responseText.includes('ok'));
}

await verifyTier1FailureFallsBack(400);
await verifyTier1FailureFallsBack(429);
await verifyTier1FailureFallsBack(502);
await verifyTier1FailureFallsBack(503);
await verifyTier1FailureFallsBack(504);

// A configured legacy count limit must never reject a healthy ninth request.
// Hold twelve actual Gateway -> private-center executions open concurrently;
// all must complete normally under the existing request-body byte budget.
__resetIsolateConcurrencyForTests();
let admitBurstArrivals = 0;
let resolveAdmissionBurst;
let markAdmissionBurstReady;
const admissionBurstBarrier = new Promise((resolve) => {
  resolveAdmissionBurst = resolve;
});
const admissionBurstReady = new Promise((resolve) => {
  markAdmissionBurstReady = resolve;
});
const admissionBurstEnv = {
  AIG_ACCESS_KEY_AIR: base.AIG_ACCESS_KEY_AIR,
  AIG_ACCESS_MODELS_AIR: '*',
  AIG_REQUEST_ADMISSION: 'true',
  AIG_ISOLATE_MAX_IN_FLIGHT: '1',
  AIG_REQUEST_HEDGE_MAX: '0',
  AIG_INFERENCE_AUTH_KEY: 'a'.repeat(32),
  AIG_TIER1_NODES_01: JSON.stringify([node('admission-burst-node')]),
  AIG_MODELS_CONFIG: JSON.stringify({ [CUTOVER_MODEL]: { policy: 'default' } }),
  AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 1, hedge: { enabled: false } } }),
  AIG_INFERENCE_SERVICE: {
    async fetch() {
      admitBurstArrivals++;
      if (admitBurstArrivals === 12) markAdmissionBurstReady();
      await admissionBurstBarrier;
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-burst',
          object: 'chat.completion',
          created: 1,
          model: CUTOVER_MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' } },
      );
    },
  },
};
const burstRequests = Array.from({ length: 12 }, (_, i) =>
  handleRequest(
    new Request('https://gateway.example.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer local-contract-access-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: CUTOVER_MODEL, messages: [{ role: 'user', content: `request ${i}` }] }),
    }),
    admissionBurstEnv,
    { waitUntil() {}, passThroughOnException() {} },
  ),
);
try {
  await Promise.race([
    admissionBurstReady,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Hard count gate or another scheduler prevented twelve concurrent arrivals')), 8_000),
    ),
  ]);
  const activity = snapshotIsolateRequestActivity();
  assert.equal(admitBurstArrivals, 12);
  assert.ok(activity.peak >= 12, 'all twelve in-flight requests must be admitted despite legacy count=1');
  assert.equal(activity.active, 12);
  const metrics = await metricsResponse(new Request('https://gateway.example.invalid/metrics'), admissionBurstEnv, 'admission-metrics').text();
  assert.ok(metrics.includes('gateway_isolate_handlers_active{} 12'), 'active handler gauge must report real concurrent work');
} finally {
  resolveAdmissionBurst();
}
const burstResults = await Promise.all(burstRequests);
assert.deepEqual(
  burstResults.map((result) => result.status),
  Array.from({ length: 12 }, () => 200),
  'request count alone must not trigger gateway_concurrency_exhausted',
);
assert.equal(snapshotIsolateRequestActivity().active, 0, 'all activity counters must release after response headers');

__resetBodyBudgetForTests();
const largeBodyReservation = admitRequestBody(20 * 1024 * 1024, 20 * 1024 * 1024);
assert.ok(largeBodyReservation, 'one 20 MiB body is admitted under the independent 32 MiB memory budget');
assert.equal(
  admitRequestBody(20 * 1024 * 1024, 20 * 1024 * 1024),
  null,
  'removing request-count rejection must never disable the 32 MiB body-memory budget',
);
largeBodyReservation();
assert.ok(admitRequestBody(20 * 1024 * 1024, 20 * 1024 * 1024), 'releasing byte budget restores capacity');
__resetBodyBudgetForTests();

async function verifyFreeKeyRotation(failureStatus, errorCode = '', schemaError = false) {
  const suffix = errorCode ? '-coded' : schemaError ? '-schema' : '';
  const first = `tier1-rotate-a-${failureStatus}${suffix}`;
  const second = `tier1-rotate-b-${failureStatus}${suffix}`;
  const dispatches = [];
  // A confirmed protocol incompatibility must be rerouted to a different
  // physical model, not replayed across Keys of the same model.
  const isConfirmedIncompatible = errorCode === 'unsupported_parameter' || schemaError;
  const alternateNode = isConfirmedIncompatible ? node(second, { models: { [CUTOVER_MODEL]: 'mock-alternate-upstream-model' } }) : node(second);
  const env = {
    AIG_ACCESS_KEY_AIR: base.AIG_ACCESS_KEY_AIR,
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_INFERENCE_AUTH_KEY: 'a'.repeat(32),
    AIG_TIER1_NODES_01: JSON.stringify([node(first), alternateNode]),
    AIG_MODELS_CONFIG: JSON.stringify({ [CUTOVER_MODEL]: { policy: 'default' } }),
    AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 2, tier_attempts: { tier1: 2 }, hedge: { enabled: false } } }),
    AIG_INFERENCE_SERVICE: {
      async fetch(request) {
        const nodeId = request.headers.get('x-aig-node-id');
        dispatches.push(nodeId);
        if (dispatches.length === 1) {
          return new Response(
            JSON.stringify(
              schemaError
                ? { detail: [{ type: 'extra_forbidden', loc: ['body', 'reasoning_effort'], msg: 'Extra inputs are not permitted' }] }
                : {
                    error: {
                      ...(errorCode
                        ? { code: errorCode }
                        : {
                            message:
                              failureStatus === 422 ? 'No endpoints found for model upstream-primary' : `Tier 1 key rejected with ${failureStatus}`,
                          }),
                    },
                  },
            ),
            {
              status: failureStatus,
              headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' },
            },
          );
        }
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-tier1-rotate',
            object: 'chat.completion',
            created: 1,
            model: CUTOVER_MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' } },
        );
      },
    },
  };
  const request = new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${base.AIG_ACCESS_KEY_AIR}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: CUTOVER_MODEL, messages: [{ role: 'user', content: 'rotate Key on failure' }] }),
  });
  const response = await handleRequest(request, env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(dispatches.length, 2, 'one failing Tier 1 key is followed by one other Key');
  assert.notEqual(dispatches[0], dispatches[1], 'never replay the same physical Key in a single request');
  assert.deepEqual(new Set(dispatches), new Set([first, second]), 'no Tier 2 node is needed when alternate free Key exists');
}
await verifyFreeKeyRotation(429);
await verifyFreeKeyRotation(503);
await verifyFreeKeyRotation(422);
await verifyFreeKeyRotation(422, 'unsupported_parameter');
await verifyFreeKeyRotation(422, 'model_not_found');
await verifyFreeKeyRotation(422, '', true);

// An attempt budget of eight is a ceiling, not a target. If the only Key
// returns 503, the gateway must terminate after ONE physical dispatch.
let exhaustedDispatches = 0;
const exhaustedEnv = {
  AIG_ACCESS_KEY_AIR: base.AIG_ACCESS_KEY_AIR,
  AIG_ACCESS_MODELS_AIR: '*',
  AIG_INFERENCE_AUTH_KEY: 'a'.repeat(32),
  AIG_TIER1_NODES_01: JSON.stringify([node('only-failing-tier1')]),
  AIG_MODELS_CONFIG: JSON.stringify({ [CUTOVER_MODEL]: { policy: 'default' } }),
  AIG_POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 8, tier_attempts: { tier1: 8 }, hedge: { enabled: false } } }),
  AIG_INFERENCE_SERVICE: {
    async fetch(request) {
      // A conversion-preflight RPC is not a physical Key/Provider dispatch.
      // Only /internal/execute carries a selected node identity.
      if (request.headers.get('x-aig-node-id')) exhaustedDispatches++;
      return new Response(JSON.stringify({ error: { message: 'temporary upstream failure' } }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' },
      });
    },
  },
};
const exhaustedReq = new Request('https://gateway.example.invalid/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${base.AIG_ACCESS_KEY_AIR}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: CUTOVER_MODEL, messages: [{ role: 'user', content: 'stop after pool exhaustion' }] }),
});
const exhaustedReply = await handleRequest(exhaustedReq, exhaustedEnv, { waitUntil() {}, passThroughOnException() {} });
assert.ok(exhaustedReply.status >= 400, 'a truly unavailable pool cannot claim success');
assert.equal(exhaustedDispatches, 1, 'a used Key must not be retried merely because max_attempts is eight');

async function verifyCrossModelProviderFailover(failureStatus, failureBody) {
  const source = `primary-${failureStatus}`;
  const fallback = `fallback-${failureStatus}`;
  const freeNode = `free-primary-${failureStatus}`;
  const paidNode = `paid-fallback-${failureStatus}`;
  const actualDispatches = [];
  const env = {
    AIG_ACCESS_KEY_AIR: 'local-contract-access-key',
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_INFERENCE_AUTH_KEY: 'a'.repeat(32),
    AIG_TIER1_NODES_01: JSON.stringify([node(freeNode, { models: { [source]: 'physical-primary' } })]),
    AIG_TIER2_NODES_01: JSON.stringify([node(paidNode, { models: { [fallback]: 'physical-fallback' } })]),
    AIG_MODELS_CONFIG: JSON.stringify({
      [source]: { policy: 'default', fallback: [fallback], fallback_mode: 'one_way', fallback_attempt_caps: [1, 1] },
      [fallback]: { policy: 'default' },
    }),
    AIG_POLICIES_CONFIG: JSON.stringify({
      default: { max_attempts: 2, tier_attempts: { tier1: 1, tier2: 1 }, hedge: { enabled: false } },
    }),
    AIG_INFERENCE_SERVICE: {
      async fetch(request) {
        const nodeId = request.headers.get('x-aig-node-id');
        actualDispatches.push(nodeId);
        if (nodeId === freeNode) {
          return new Response(JSON.stringify({ error: { message: failureBody } }), {
            status: failureStatus,
            headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' },
          });
        }
        assert.equal(nodeId, paidNode, 'fallback must be routed to a real Tier 2 node with a different model');
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-cross-model',
            object: 'chat.completion',
            created: 1,
            model: fallback,
            choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' } },
        );
      },
    },
  };
  const request = new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer local-contract-access-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: source, messages: [{ role: 'user', content: 'recover from upstream failure' }] }),
  });
  const result = await handleRequest(request, env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(result.status, 200, `Cross-model ${failureStatus} must recover: ${await result.clone().text()}`);
  assert.equal(result.headers.get('x-gateway-failover'), 'true', 'success must prove a real previous Provider failure');
  assert.equal(result.headers.get('x-gateway-dispatches'), '2', 'success evidence must count both physical attempts');
  assert.equal(result.headers.get('x-gateway-attempts'), '2');
  assert.equal((await result.json()).choices?.[0]?.message?.content, 'recovered');
  assert.deepEqual(actualDispatches, [freeNode, paidNode], 'exactly one physical attempt per model across both tiers');
}

await verifyCrossModelProviderFailover(503, 'temporarily unavailable');
await verifyCrossModelProviderFailover(422, 'No endpoints found for model physical-primary');

// Preserve legacy 400-as-node-incompatibility routing (tested above), but
// a structured invalid client request 422 must NOT be replayed on other Keys or paid fallback.
async function verifyTerminalClientError(status) {
  const freeId = `free-terminal-${status}`;
  const dispatched = [];
  const env = {
    AIG_ACCESS_KEY_AIR: 'local-contract-access-key',
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_INFERENCE_AUTH_KEY: 'a'.repeat(32),
    AIG_TIER1_NODES_01: JSON.stringify([node(freeId)]),
    AIG_TIER2_NODES_01: JSON.stringify([node(`token-terminal-${status}`)]),
    AIG_MODELS_CONFIG: JSON.stringify({ [CUTOVER_MODEL]: { policy: 'default' } }),
    AIG_POLICIES_CONFIG: JSON.stringify({
      default: { max_attempts: 4, tier_attempts: { tier1: 2, tier2: 2 }, hedge: { enabled: false } },
    }),
    AIG_INFERENCE_SERVICE: {
      async fetch(request) {
        dispatched.push(request.headers.get('x-aig-node-id'));
        return new Response(JSON.stringify({ error: { code: 'invalid_json', message: 'mock invalid input' } }), {
          status,
          headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' },
        });
      },
    },
  };
  const request = new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer local-contract-access-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: CUTOVER_MODEL, messages: [{ role: 'user', content: 'test invalid input' }] }),
  });
  const response = await handleRequest(request, env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, status, `Provider ${status} must remain terminal: ${await response.clone().text()}`);
  assert.deepEqual(dispatched, [freeId], `Provider ${status} must not consume fallback dispatches`);
  const payload = await response.json();
  assert.match(payload.error?.message, /^422 \| /, 'terminal client errors must start with the HTTP status');
  assert.equal(payload.error?.details?.attempts, undefined, 'internal attempt graph must not leak into client errors');
  assert.equal(response.headers.get('x-gateway-attempts'), '1', 'attempt count stays available in diagnostic headers');
  assert.equal(response.headers.get('x-gateway-dispatches'), '1', 'dispatch count stays available in diagnostic headers');
}

await verifyTerminalClientError(422);

async function verifyStreamGuardAcceptsJsonFallback() {
  const physicalRequests = [];
  const attemptEvents = [];
  const env = {
    AIG_ACCESS_KEY_AIR: 'local-contract-access-key',
    AIG_ACCESS_MODELS_AIR: '*',
    AIG_HAS_STREAM_GUARD: 'true',
    AIG_INFERENCE_AUTH_KEY: 'a'.repeat(32),
    GATEWAY_EVENTS: { writeDataPoint: (event) => attemptEvents.push(event) },
    AIG_TIER1_NODES_01: JSON.stringify([node('stream-guard-free')]),
    AIG_MODELS_CONFIG: JSON.stringify({ [CUTOVER_MODEL]: { policy: 'default' } }),
    AIG_POLICIES_CONFIG: JSON.stringify({
      default: { max_attempts: 1, tier_attempts: { tier1: 1 }, hedge: { enabled: false } },
    }),
    AIG_INFERENCE_SERVICE: {
      async fetch(request) {
        const requestBody = await request.json();
        physicalRequests.push({
          path: new URL(request.url).pathname,
          stream: requestBody.stream,
        });
        // Mock a Provider that ignores the private Center's stream:true body.
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-fallback',
            object: 'chat.completion',
            created: 1,
            model: CUTOVER_MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: 'json fallback' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
          }),
          { status: 200, headers: { 'content-type': 'application/json', 'x-aig-result': 'dispatched' } },
        );
      },
    },
  };
  const request = new Request('https://gateway.example.invalid/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer local-contract-access-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: CUTOVER_MODEL, messages: [{ role: 'user', content: 'hello' }] }),
  });
  const response = await handleRequest(request, env, { waitUntil() {}, passThroughOnException() {} });
  const body = await response.json();
  assert.equal(response.status, 200, 'A Provider JSON reply must be accepted if it ignored stream:true');
  assert.equal(body.choices[0]?.message.content, 'json fallback');
  assert.deepEqual(body.usage, { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 });
  assert.deepEqual(physicalRequests, [{ path: '/internal/execute', stream: true }]);
  assert.equal(attemptEvents.length, 1, 'one physical execution produces exactly one accounting event');
  assert.equal(attemptEvents[0].blobs[4], 'ok');
  const [status, headersMs, ttftMs, latencyMs] = attemptEvents[0].doubles;
  assert.equal(status, 200);
  for (const [name, value] of Object.entries({ headersMs, ttftMs, latencyMs })) {
    assert.ok(Number.isFinite(value) && value >= 0, `${name} is recorded as a non-negative finite metric`);
  }
}

await verifyStreamGuardAcceptsJsonFallback();

// State-module extraction regressions: one store, unchanged quota reservations,
// fixed 429 scope, half-open transition, and read-only diagnostic snapshots.
const tier1State = await import('../src/reliability/tier1-state.ts');
const tier1Store = await import('../src/reliability/tier1-store.ts');
assert.equal(tier1State.getTier1Account, tier1Store.getTier1Account, 'facade must use the one state store');
assert.equal(tier1State.getTier1Model, tier1Store.getTier1Model, 'facade must use the same model objects');
tier1State.__resetTier1StateForTests();
const stateAccountId = 'tier1-split-contract';
const stateModelId = 'split-model';
const stateAccount = tier1State.getTier1Account(stateAccountId);
assert.equal(stateAccount, tier1Store.tier1Accounts.get(stateAccountId));
const rateLimitOutcome = tier1State.classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'model', retryAfterMs: 30_000 });
tier1State.applyTier1Outcome(stateAccountId, stateModelId, rateLimitOutcome, 10_000);
assert.equal(tier1State.getTier1Model(stateAccountId, stateModelId).cooldownUntil, 40_000);
assert.equal(tier1State.getTier1Model(stateAccountId, stateModelId).rateLimitRecoveryPending, true);
assert.equal(tier1State.decideTier1RateLimitScope(stateAccountId, 'model-A', 11_000), 'model');
assert.equal(tier1State.decideTier1RateLimitScope(stateAccountId, 'model-B', 11_001), 'account');
const halfOpenId = 'tier1-split-half-open';
const serverOutcome = tier1State.classifyTier1Failure({ kind: 'server' });
for (let n = 0; n < tier1State.TIER1_FAILURE_THRESHOLD; n++) {
  tier1State.applyTier1Outcome(halfOpenId, stateModelId, serverOutcome, 20_000 + n);
}
const halfOpenModel = tier1State.getTier1Model(halfOpenId, stateModelId);
assert.equal(halfOpenModel.failureState, 'cooldown');
const recoveryAt = halfOpenModel.cooldownUntil + 1;
tier1State.maybeTransitionToHalfOpen(halfOpenId, stateModelId, recoveryAt);
assert.equal(halfOpenModel.failureState, 'half_open');
tier1State.recordTier1Success(halfOpenId, stateModelId, recoveryAt);
assert.equal(halfOpenModel.failureState, 'half_open', 'one half-open success is insufficient');
tier1State.recordTier1Success(halfOpenId, stateModelId, recoveryAt + 1);
assert.equal(halfOpenModel.failureState, 'normal', 'two successes restore normal state');
const quotaId = 'tier1-split-quota';
const quotaNow = 100_000;
assert.equal(
  tier1State.recordTier1QuotaReport(
    quotaId,
    {
      remainingRequests: 2,
      limitRequests: 100,
      resetAtMs: quotaNow + 60_000,
      source: 'contract-test',
    },
    quotaNow,
  ),
  true,
);
assert.equal(tier1State.tier1QuotaState(quotaId, quotaNow), 'near_limit');
const quotaNode = {
  id: quotaId,
  provider: 'openai',
  tier: 'tier-1',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  models: { [stateModelId]: 'physical-model' },
};
assert.equal(tier1State.claimTier1Slot(quotaNode, quotaNow, stateModelId), true);
const quotaToken = tier1State.makeTier1ReleaseToken(quotaId, stateModelId);
assert.equal(tier1Store.tier1Accounts.get(quotaId).quotaRemainingRequests, 1);
tier1State.settleTier1Quota(quotaId, quotaToken, 5);
assert.equal(tier1State.releaseTier1Slot(quotaId, quotaToken), true);
assert.equal(tier1Store.tier1Accounts.get(quotaId).quotaRemainingRequests, 1, 'settled quota is not refunded');
assert.equal(tier1State.snapshotTier1Runtime(quotaId, stateModelId, quotaNow).quota_state, 'near_limit');
assert.equal(tier1State.snapshotTier1AccountRuntime(quotaId, [stateModelId], quotaNow).models.length, 1);
tier1State.__resetTier1StateForTests();
assert.equal(tier1Store.tier1Accounts.size, 0, 'reset clears the same store seen by diagnostics');

// Mixed 429 + headers timeout must retain the cooldown of a configured
// compatible-model fallback, even when the terminal-status tie selects 504.
// Use opaque model names so the test cannot pass through hard-coded Code aliases.
const retrySource = 'retry-source';
const retryTarget = 'retry-target';
const retryEnv = {
  AIG_MODELS_CONFIG: JSON.stringify({
    [retrySource]: { fallback: [retryTarget] },
    [retryTarget]: {},
  }),
};
const retryTargetNode = {
  id: 'tier2-family-retry-cooldown',
  tier: 'tier-2',
  provider: 'openai',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  baseUrl: 'https://provider.invalid/v1',
  credential: '',
  priority: 0,
  models: { [retryTarget]: 'physical-retry-target' },
};
getNodeState(retryTargetNode.id).cooldownUntil = Date.now() + 20_000;
const retryState = (failureKinds) => ({
  attempted: new Set([retryTargetNode.id]),
  attempts: [{ status: 429 }],
  logicalAttempts: 8,
  dispatches: 8,
  hedges: 0,
  failureKinds,
  logger: { info() {}, error() {}, debug() {} },
  requestId: 'retry-test-request',
  maxAttempts: 8,
  maxDispatches: 8,
  requestedModel: retrySource,
  nodes: [retryTargetNode],
  knownModels: new Set([retrySource, retryTarget]),
});
const exhausted = (kinds) =>
  buildExhaustedResponse(
    new Request('https://gateway.invalid/v1/chat/completions'),
    retryEnv,
    'openai_chat',
    'retry-test-request',
    retrySource,
    retryState(kinds),
    { 1: [], 2: [retryTargetNode] },
    false,
    { route: 'openai_chat', model: retrySource, protocol: 'openai', surface: 'chat_completions' },
    new Set([retrySource, retryTarget]),
    true,
  );
const mixedRetry = exhausted({ rate_limit: 4, headers_timeout: 4 });
assert.equal(mixedRetry.status, 503);
assert.equal(mixedRetry.headers.get('x-gateway-error-code'), 'gateway_attempt_budget_exhausted');
assert.ok(Number(mixedRetry.headers.get('retry-after')) >= 15, 'mixed 429/timeout exhaustion retains the configured fallback model cooldown');
const mixedRetryBody = await mixedRetry.json();
assert.equal(mixedRetryBody.error.details?.retry_after_ms, Number(mixedRetry.headers.get('retry-after')) * 1000);
assert.equal(mixedRetry.headers.get('x-should-retry'), 'false', 'long family cooldown must stop immediate SDK replay');
assert.equal(mixedRetry.headers.get('x-gateway-retryable'), 'true', 'a later retry remains possible after the declared cooldown');
assert.equal(mixedRetry.headers.get('x-gateway-retryable'), 'true', 'recovery after the declared cooldown remains possible');
assert.match(mixedRetryBody.error.message, /^503 \| .*retry after [0-9]+s\.$/, 'long cooldown must be a concise status-first hint');
const pureRateLimit = exhausted({ rate_limit: 8 });
assert.equal(pureRateLimit.status, 503);
assert.equal(pureRateLimit.headers.get('x-should-retry'), null, 'pure 429 capacity failures retain the legacy SDK retry contract');
const timeoutRetry = exhausted({ headers_timeout: 8 });
assert.equal(timeoutRetry.status, 503);
assert.equal(timeoutRetry.headers.get('retry-after'), '1', 'timeouts alone retain the bounded 1s retry hint');
assert.equal(timeoutRetry.headers.get('x-should-retry'), null, 'short transient failures retain normal SDK retry behavior');

// An exhausted model-family pass must describe the actual dispatched model,
// not the original model's unrelated physical mapping. No credentials or
// request body are included in the per-attempt diagnostic record.
const diagnosticNode = {
  ...retryTargetNode,
  id: 'tier2-effective-model-diagnostic',
  models: { [retrySource]: 'physical-source', [retryTarget]: 'physical-target' },
};
const diagnosticLogs = [];
const diagnosticState = {
  ...retryState({}),
  attempted: new Set(),
  attempts: [],
  logicalAttempts: 0,
  dispatches: 0,
  logger: { info: (message) => diagnosticLogs.push(message), error() {}, debug() {} },
  nodes: [diagnosticNode],
};
recordOutcome(
  diagnosticState,
  diagnosticNode,
  { kind: 'headers_timeout', action: 'neutral', counted: false, cooldownMs: 0 },
  {
    state: diagnosticState,
    env: {},
    logger: diagnosticState.logger,
    requestId: 'attempt-model-diagnostic-test',
    requestedModel: retrySource,
    reqDescriptor: { model: retryTarget, route: 'openai_chat', protocol: 'openai', surface: 'chat_completions' },
    upstreamProtocol: 'openai',
    surface: 'chat_completions',
    attemptStartMs: 10_000,
    attemptDeadlineMs: 15_000,
    attemptSettlement: { observedUsage: null, settled: true },
  },
  { latencyMs: 500, status: 504 },
);
assert.equal(diagnosticState.dispatches, 1);
assert.equal(diagnosticState.attempts[0].effective_model, retryTarget);
assert.equal(diagnosticState.attempts[0].upstream_model, 'physical-target');
assert.equal(diagnosticState.attempts[0].attempt_window_ms, 5_000);
assert.equal(diagnosticState.attempts[0].kind, 'headers_timeout');
assert.ok(diagnosticLogs[0].includes('model=retry-source=>retry-target->physical-target'), 'fallback diagnostics use the dispatched model');
assert.ok(diagnosticLogs[0].includes('attempt_window_ms=5000'), 'timeout diagnostics expose the actual reserved attempt window');
assert.ok(!diagnosticLogs[0].includes('physical-source'), 'the source model mapping must not be misattributed');

recordOutcome(
  diagnosticState,
  diagnosticNode,
  { kind: 'headers_timeout', action: 'neutral', counted: false, cooldownMs: 0 },
  {
    state: diagnosticState,
    env: {},
    logger: diagnosticState.logger,
    requestId: 'legacy-outcome-diagnostic-test',
    requestedModel: retrySource,
    attemptSettlement: { observedUsage: null, settled: true },
  },
  { latencyMs: 2, status: 504 },
);
assert.equal(diagnosticState.attempts[1].effective_model, retrySource, 'legacy callers without descriptors retain the requested model');
assert.equal(diagnosticState.attempts[1].upstream_model, 'physical-source', 'legacy callers retain their original physical model mapping');
// A key-fingerprint flood must not trigger a 5000-entry eviction scan per
// request. Keep the most recently used denial window and evict only the
// oldest record (not an extra 10% of still-active rate limits).
const rpmEpoch = 1_000_000;
__resetKeyRpmForTests();
for (let i = 0; i < 5_000; i++) {
  assert.equal(admitKeyRequest(`group-${i}`, 1, rpmEpoch + i).ok, true);
}
assert.equal(admitKeyRequest('group-0', 1, rpmEpoch + 5_000).ok, false, 'an active group remains throttled');
assert.equal(admitKeyRequest('group-5000', 1, rpmEpoch + 5_001).ok, true);
assert.equal(getKeyRpmSnapshot('group-0', rpmEpoch + 5_002).used, 1, 'recently denied group retains its history');
assert.equal(getKeyRpmSnapshot('group-1', rpmEpoch + 5_002).used, 0, 'only the oldest group is evicted');
assert.equal(getKeyRpmSnapshot('group-2', rpmEpoch + 5_002).used, 1, 'no extra rate-limit histories are discarded');

__resetKeyRpmForTests();
for (let i = 0; i < 5_000; i++) recordAuthFailure(`invalid-${i}`, rpmEpoch + i);
recordAuthFailure('invalid-0', rpmEpoch + 5_000);
recordAuthFailure('invalid-5000', rpmEpoch + 5_001);
assert.equal(admitAuthAttempt('invalid-0', 1, rpmEpoch + 5_002).ok, false, 'active invalid credential stays throttled');
assert.equal(admitAuthAttempt('invalid-1', 1, rpmEpoch + 5_002).ok, true, 'only the oldest invalid fingerprint is evicted');
assert.equal(admitAuthAttempt('invalid-2', 1, rpmEpoch + 5_002).ok, false, 'another invalid fingerprint remains throttled');
__resetKeyRpmForTests();

// Observability is isolate-local and must not perform extra KV writes or Provider calls.
__resetTier1StateForTests();
__resetSharedTier1CooldownsForTests();
let kvReads = 0;
let kvWrites = 0;
const kv = {
  async get() {
    kvReads++;
    return null;
  },
  async put() {
    kvWrites++;
  },
};
const kvEnv = { TIER1_AFFINITY: kv };
await hydrateSharedTier1Cooldowns(kvEnv);
assert.equal(snapshotSharedTier1Cooldowns().reads, 1);
const tasks = [];
const now = Date.now();
adoptTier1Cooldown({ node: 'metric-test-account', until: now + 600_000, reason: 'auth' }, now);
shareLongTier1Cooldowns(
  kvEnv,
  {
    waitUntil(task) {
      tasks.push(task);
    },
  },
  'metric-test-account',
  now,
);
await Promise.all(tasks);
assert.equal(kvWrites, 1);
assert.equal(snapshotSharedTier1Cooldowns().writes, 1);
const before = kvReads;
const response = await metricsResponse(new Request('https://gateway.example/metrics'), {}, 'metrics-test');
const body = await response.text();
assert.equal(response.status, 200);
assert.match(body, /gateway_tier1_accounts_configured\{\} 0/);
assert.match(body, /gateway_tier1_shared_kv_writes_total\{\} 1/);
assert.match(body, /gateway_tier1_shared_kv_reads_total\{\} 2/);
assert.equal(kvReads, before, 'reading metrics must not cause more KV requests');
__resetSharedTier1CooldownsForTests();
__resetTier1StateForTests();

// A transient KV failure must not poison the isolate-local "already shared"
// cache. Retry only after one minute, on a subsequent real cooldown event.
const retryClock = Date.now();
adoptTier1Cooldown({ node: 'retry-account', until: retryClock + 900_000, reason: 'auth' }, retryClock);
let retryWrites = 0;
let storedCooldown = null;
const retryKv = {
  async get() {
    return storedCooldown;
  },
  async put(_key, value) {
    retryWrites++;
    if (retryWrites === 1) throw new Error('transient KV write failure');
    storedCooldown = value;
  },
};
const retryTasks = [];
const retryContext = {
  waitUntil(task) {
    retryTasks.push(task);
  },
};
const sharedRetryEnv = { TIER1_AFFINITY: retryKv };
shareLongTier1Cooldowns(sharedRetryEnv, retryContext, 'retry-account', retryClock);
await Promise.all(retryTasks);
assert.equal(retryWrites, 1);
assert.equal(snapshotSharedTier1Cooldowns().writeFailures, 1);
assert.equal(snapshotSharedTier1Cooldowns().writes, 0);
shareLongTier1Cooldowns(sharedRetryEnv, retryContext, 'retry-account', retryClock + 1_000);
assert.equal(retryWrites, 1, 'a failed KV write must not be retried on each request');
shareLongTier1Cooldowns(sharedRetryEnv, retryContext, 'retry-account', retryClock + 61_000);
await Promise.all(retryTasks);
assert.equal(retryWrites, 2, 'next eligible cooldown event retries after backoff');
assert.equal(snapshotSharedTier1Cooldowns().writes, 1);
assert.equal(snapshotSharedTier1Cooldowns().writeFailures, 1);
assert.equal(JSON.parse(storedCooldown ?? '[]')[0]?.node, 'retry-account');
shareLongTier1Cooldowns(sharedRetryEnv, retryContext, 'retry-account', retryClock + 62_000);
assert.equal(retryWrites, 2, 'successfully shared cooldown must not be rewritten');
__resetSharedTier1CooldownsForTests();
__resetTier1StateForTests();

console.log(
  'Two-Tier runtime contracts passed (Tier 1 to Tier 2 429/503 recovery, ignored-stream JSON fallback, routing, private credentials and fail-closed migration guards).',
);
