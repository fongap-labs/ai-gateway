#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createReadOnlyCloudflareClient, inspectProductionWorkers } from './cloudflare-live-inventory.mjs';

const WORKERS = ['ai-gateway', 'ai-inference-center', 'ai-generation-center', 'ai-gateway-operations'];
const SECRET_SENTINEL = 'never-print-this-secret-value';
const D1_ID = '123e4567-e89b-42d3-a456-426614174000';
const KV_ID = '123e4567-e89b-42d3-a456-426614174001';
const BASE_SETTINGS = {
  'ai-gateway': [
    { name: 'AIG_INFERENCE_SERVICE', type: 'service', service: 'ai-inference-center' },
    { name: 'AIG_GENERATION_SERVICE', type: 'service', service: 'ai-generation-center' },
    { name: 'TIER1_AFFINITY', type: 'kv_namespace', namespace_id: KV_ID },
    { name: 'TOKEN_STATS_DB', type: 'd1', database_id: D1_ID },
    { name: 'AIG_INFERENCE_AUTH_KEY', type: 'secret_text' },
    { name: 'AIG_GENERATION_AUTH_KEY', type: 'secret_text' },
    { name: 'AIG_ACCESS_KEY_AIR', type: 'secret_text' },
  ],
  'ai-inference-center': [
    { name: 'AIG_INFERENCE_AUTH_KEY', type: 'secret_text' },
    { name: 'AIG_TIER1_CREDENTIALS_01', type: 'secret_text' },
  ],
  'ai-generation-center': [
    { name: 'AIG_GENERATION_AUTH_KEY', type: 'secret_text' },
    { name: 'AIG_TIER2_CREDENTIALS_01', type: 'secret_text' },
  ],
  'ai-gateway-operations': [{ name: 'TOKEN_STATS_DB', type: 'd1', database_id: D1_ID }],
};

function makeDomain(id, service, enabled = true, previewsEnabled = false) {
  return { id, service, enabled, previews_enabled: previewsEnabled, hostname: 'private-host-must-not-leak.invalid' };
}

function makeFetch(overrides = {}) {
  const calls = [];
  const settings = structuredClone(overrides.settings ?? BASE_SETTINGS);
  const routes = overrides.routesByWorker ?? { 'ai-gateway': [{ id: 'r1', pattern: 'api.example.invalid/*', script: 'ai-gateway' }] };
  const cron = overrides.cron ?? {
    'ai-gateway': ['0 3 * * *'],
    'ai-inference-center': [],
    'ai-generation-center': [],
    'ai-gateway-operations': [],
  };
  const subdomains = overrides.subdomains ?? {};
  const deployments = overrides.deployments ?? {};
  const domainsPageOne = Array.from({ length: 100 }, (_, index) => makeDomain('other-' + index, 'unrelated-worker'));
  const domainsPageTwo = overrides.domainsPageTwo ?? [makeDomain('domain-gateway', 'ai-gateway')];
  const zoneId = (index) => index.toString(16).padStart(32, '0');

  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, '').replace(/^\/client\/v4/, '');
    let result;
    let resultInfo;
    if (endpoint === '/workers/scripts') {
      assert.equal(parsed.search, '', 'Worker Scripts list is not paginated');
      result = WORKERS.map((id) => ({ id }));
    } else if (endpoint === '/zones') {
      assert.equal(parsed.searchParams.get('account.id'), 'a'.repeat(32));
      assert.equal(parsed.searchParams.get('per_page'), '50');
      const page = Number(parsed.searchParams.get('page'));
      assert.ok(page === 1 || page === 2);
      const start = (page - 1) * 50;
      const count = page === 1 ? 50 : 1;
      result = Array.from({ length: count }, (_, offset) => ({ id: zoneId(start + offset), account: { id: 'a'.repeat(32) } }));
      resultInfo = { page, per_page: 50, total_pages: 2 };
    } else if (/^\/zones\/[0-9a-f]{32}\/workers\/routes$/.test(endpoint)) {
      const [, zone] = endpoint.match(/^\/zones\/([0-9a-f]{32})\/workers\/routes$/);
      result = zone === zoneId(0) ? Object.values(routes).flat() : [];
    } else if (endpoint === '/workers/domains') {
      const page = Number(parsed.searchParams.get('page'));
      assert.equal(parsed.searchParams.get('per_page'), '100');
      assert.ok(page === 1 || page === 2);
      result = page === 1 ? domainsPageOne : domainsPageTwo;
      resultInfo = { page, per_page: 100, total_pages: 2 };
    } else {
      const match = endpoint.match(/^\/workers\/scripts\/([^/]+)\/(settings|schedules|subdomain|deployments)$/);
      assert.ok(match, 'Unexpected or prohibited API endpoint: ' + endpoint);
      const [, worker, resource] = match;
      assert.ok(WORKERS.includes(worker));
      if (resource === 'settings') result = { bindings: settings[worker] ?? [] };
      if (resource === 'schedules') result = { schedules: (cron[worker] ?? []).map((value) => ({ cron: value })) };
      if (resource === 'subdomain') result = subdomains[worker] ?? { enabled: false, previews_enabled: false };
      if (resource === 'deployments') {
        assert.equal(parsed.searchParams.get('page'), '1');
        assert.equal(parsed.searchParams.get('per_page'), '1');
        result = { deployments: deployments[worker] ?? [{ id: 'deployment-' + worker, versions: [{ version_id: 'version-1', percentage: 100 }] }] };
      }
    }
    return new Response(JSON.stringify({ success: true, result, ...(resultInfo ? { result_info: resultInfo } : {}) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const mock = makeFetch();
const client = createReadOnlyCloudflareClient({ accountId: 'a'.repeat(32), token: 'mock-read-only-token-123', fetchImpl: mock.fetchImpl });
const report = await inspectProductionWorkers(client);

assert.equal(report.metadata_consistency, 'pass');
assert.equal(report.cron_phase, 'prepare');
assert.equal(report.production_cutover_approved, false);
assert.equal(report.checks.shared_token_stats_d1_consistent, true);
assert.equal(report.checks.tier1_kv_binding_present, true);
assert.equal(report.checks.gateway_provider_credential_binding_count, 0);
assert.equal(report.checks.account_zone_count_scanned, 51);
assert.equal(report.workers['ai-gateway'].active_traffic_version_count, 1);
assert.equal(report.workers['ai-gateway'].exposure.worker_route_count, 1);
assert.equal(report.workers['ai-gateway'].exposure.enabled_custom_domain_count, 1);
assert.deepEqual(report.workers['ai-gateway'].secret_names, ['AIG_ACCESS_KEY_AIR', 'AIG_GENERATION_AUTH_KEY', 'AIG_INFERENCE_AUTH_KEY']);
assert.equal(JSON.stringify(report).includes(SECRET_SENTINEL), false);
assert.equal(JSON.stringify(report).includes('private-host-must-not-leak.invalid'), false);
assert.deepEqual(
  mock.calls.map((call) => call.method),
  mock.calls.map(() => 'GET'),
  'Every Cloudflare request must use GET',
);
assert.equal(
  mock.calls.some((call) => new URL(call.url).pathname.endsWith('/secrets')),
  false,
  'Secrets endpoint must never be called',
);
assert.equal(mock.calls.filter((call) => new URL(call.url).pathname.endsWith('/workers/domains')).length, 2, 'All domain pages must be read');
assert.equal(
  mock.calls.some((call) => new URL(call.url).pathname.endsWith('/workers/scripts') && new URL(call.url).search),
  false,
);

const missingGatewayRouteMock = makeFetch({ routesByWorker: {}, domainsPageTwo: [] });
const missingGatewayRouteReport = await inspectProductionWorkers(
  createReadOnlyCloudflareClient({
    accountId: 'a'.repeat(32),
    token: 'mock-read-only-token-123',
    fetchImpl: missingGatewayRouteMock.fetchImpl,
  }),
);
assert.ok(missingGatewayRouteReport.blockers.includes('GATEWAY_PUBLIC_ROUTE_MISSING'));

const secretValueMock = makeFetch({
  settings: {
    ...structuredClone(BASE_SETTINGS),
    'ai-inference-center': [{ name: 'AIG_INFERENCE_AUTH_KEY', type: 'secret_text', text: SECRET_SENTINEL }],
  },
});
await assert.rejects(
  inspectProductionWorkers(
    createReadOnlyCloudflareClient({ accountId: 'a'.repeat(32), token: 'mock-read-only-token-123', fetchImpl: secretValueMock.fetchImpl }),
  ),
  /Secret values are not permitted/,
);

const privateRouteMock = makeFetch({ routesByWorker: { 'ai-inference-center': [{ id: 'r-private', pattern: '*', script: 'ai-inference-center' }] } });
const privateRouteReport = await inspectProductionWorkers(
  createReadOnlyCloudflareClient({ accountId: 'a'.repeat(32), token: 'mock-read-only-token-123', fetchImpl: privateRouteMock.fetchImpl }),
);
assert.ok(privateRouteReport.blockers.includes('PRIVATE_WORKER_EXPOSED:ai-inference-center'));

const privateDomainMock = makeFetch({
  settings: { ...structuredClone(BASE_SETTINGS), 'ai-inference-center': BASE_SETTINGS['ai-inference-center'] },
});
const privateDomainFetch = privateDomainMock.fetchImpl;
const privateDomainReport = await inspectProductionWorkers(
  createReadOnlyCloudflareClient({
    accountId: 'a'.repeat(32),
    token: 'mock-read-only-token-123',
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const endpoint = parsed.pathname.replace(/^\/client\/v4\/accounts\/[^/]+/, '').replace(/^\/client\/v4/, '');
      if (endpoint === '/workers/domains' && parsed.searchParams.get('page') === '2') {
        const body = await privateDomainFetch(url, init);
        const json = await body.json();
        json.result.push(makeDomain('domain-inference', 'ai-inference-center', true, false));
        return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return privateDomainFetch(url, init);
    },
  }),
);
assert.ok(privateDomainReport.blockers.includes('PRIVATE_WORKER_EXPOSED:ai-inference-center'));

const unsafeMock = makeFetch({
  cron: {
    'ai-gateway': ['0 3 * * *'],
    'ai-inference-center': [],
    'ai-generation-center': [],
    'ai-gateway-operations': ['0 3 * * *'],
  },
  settings: {
    ...structuredClone(BASE_SETTINGS),
    'ai-gateway-operations': [
      { name: 'TOKEN_STATS_DB', type: 'd1', database_id: '123e4567-e89b-42d3-a456-426614174099' },
      { name: 'AIG_TIER1_CREDENTIALS_01', type: 'secret_text' },
    ],
    'ai-gateway': [...BASE_SETTINGS['ai-gateway'], { name: 'AIG_TIER2_CREDENTIALS_01', type: 'secret_text' }],
  },
});
const unsafeReport = await inspectProductionWorkers(
  createReadOnlyCloudflareClient({ accountId: 'a'.repeat(32), token: 'mock-read-only-token-123', fetchImpl: unsafeMock.fetchImpl }),
);
assert.equal(unsafeReport.cron_phase, 'unsafe');
assert.ok(unsafeReport.blockers.includes('CRON_OWNERSHIP_UNSAFE'));
assert.ok(unsafeReport.blockers.includes('SHARED_D1_MISMATCH'));
assert.ok(unsafeReport.blockers.includes('GATEWAY_PROVIDER_CREDENTIALS_PRESENT'));
assert.ok(unsafeReport.blockers.includes('OPERATIONS_PROVIDER_CREDENTIALS_PRESENT'));

assert.throws(
  () => createReadOnlyCloudflareClient({ accountId: 'invalid', token: 'mock-read-only-token-123', fetchImpl: mock.fetchImpl }),
  /read-only credentials/,
);

console.log(
  'Cloudflare live inventory contract passed: GET-only, paginated zones/domains, safe Secret metadata, complete route checks, and fail-closed ownership detection.',
);
