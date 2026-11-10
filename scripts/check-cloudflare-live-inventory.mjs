#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createReadOnlyCloudflareClient, InventoryDiagnosticError, inspectProductionWorkers } from './cloudflare-live-inventory.mjs';

const WORKERS = ['ai-gateway', 'ai-inference-center', 'ai-perception-center', 'ai-generation-center', 'ai-gateway-operations'];
const SECRET_SENTINEL = 'never-print-this-secret-value';
const D1_ID = '123e4567-e89b-42d3-a456-426614174000';
const KV_ID = '123e4567-e89b-42d3-a456-426614174001';
const BUILD_SHA = 'a'.repeat(40);
const BASE_SETTINGS = {
  'ai-gateway': [
    { name: 'AIG_BUILD_SHA', type: 'plain_text', text: BUILD_SHA },
    { name: 'AIG_INFERENCE_SERVICE', type: 'service', service: 'ai-inference-center' },
    { name: 'AIG_PERCEPTION_SERVICE', type: 'service', service: 'ai-perception-center' },
    { name: 'AIG_GENERATION_SERVICE', type: 'service', service: 'ai-generation-center' },
    { name: 'TIER1_AFFINITY', type: 'kv_namespace', namespace_id: KV_ID },
    { name: 'TOKEN_STATS_DB', type: 'd1', database_id: D1_ID },
    { name: 'AIG_INFERENCE_AUTH_KEY', type: 'secret_text' },
    { name: 'AIG_PERCEPTION_AUTH_KEY', type: 'secret_text' },
    { name: 'AIG_GENERATION_AUTH_KEY', type: 'secret_text' },
    { name: 'AIG_ACCESS_KEY_AIR', type: 'secret_text' },
  ],
  'ai-inference-center': [
    { name: 'AIG_BUILD_SHA', type: 'plain_text', text: BUILD_SHA },
    { name: 'AIG_INFERENCE_AUTH_KEY', type: 'secret_text' },
    { name: 'AIG_TIER1_CREDENTIALS_01', type: 'secret_text' },
  ],
  'ai-generation-center': [
    { name: 'AIG_BUILD_SHA', type: 'plain_text', text: BUILD_SHA },
    { name: 'AIG_GENERATION_AUTH_KEY', type: 'secret_text' },
    { name: 'AIG_TIER2_CREDENTIALS_01', type: 'secret_text' },
  ],
  'ai-perception-center': [
    { name: 'AIG_BUILD_SHA', type: 'plain_text', text: BUILD_SHA },
    { name: 'AIG_PERCEPTION_AUTH_KEY', type: 'secret_text' },
    { name: 'AIG_TIER1_CREDENTIALS_01', type: 'secret_text' },
  ],
  'ai-gateway-operations': [
    { name: 'AIG_BUILD_SHA', type: 'plain_text', text: BUILD_SHA },
    { name: 'TOKEN_STATS_DB', type: 'd1', database_id: D1_ID },
  ],
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
    'ai-perception-center': [],
    'ai-generation-center': [],
    'ai-gateway-operations': [],
  };
  const subdomains = overrides.subdomains ?? {};
  const deployments = overrides.deployments ?? {};
  const domainsByService = overrides.domainsByService ?? { 'ai-gateway': [makeDomain('domain-gateway', 'ai-gateway')] };
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
      const count = page === 1 ? (overrides.zonePageOneCount ?? 50) : 1;
      result = Array.from({ length: count }, (_, offset) => ({ id: zoneId(start + offset), account: { id: 'a'.repeat(32) } }));
      resultInfo = {
        page,
        per_page: 50,
        count: result.length,
        total_count: 51,
        total_pages: 2,
        ...(overrides.zonePageInfo?.[page] ?? {}),
      };
    } else if (/^\/zones\/[0-9a-f]{32}\/workers\/routes$/.test(endpoint)) {
      const [, zone] = endpoint.match(/^\/zones\/([0-9a-f]{32})\/workers\/routes$/);
      result = zone === zoneId(0) ? Object.values(routes).flat() : [];
    } else if (endpoint === '/workers/domains') {
      const service = parsed.searchParams.get('service');
      assert.ok(WORKERS.includes(service));
      assert.equal(parsed.searchParams.has('page'), false, 'Worker Domains does not document page pagination');
      assert.equal(parsed.searchParams.has('per_page'), false, 'Worker Domains does not document per_page pagination');
      result = domainsByService[service] ?? [];
      resultInfo = { count: result.length, total_pages: 1, ...(overrides.domainResultInfo?.[service] ?? {}) };
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

// Fault categories are stable and cannot contain Cloudflare error bodies,
// access token material, account identifiers or arbitrary endpoint URLs.
const sensitiveApiText = 'private-cloudflare-error-body-must-never-leak';
async function assertSafeFailure(fetchImpl, expectedCode, expectedStage, expectedStatus = null, call = 'scripts') {
  const client = createReadOnlyCloudflareClient({
    accountId: 'a'.repeat(32),
    token: 'redacted-testing-token-123',
    fetchImpl,
  });
  await assert.rejects(client[call](), (error) => {
    assert.ok(error instanceof InventoryDiagnosticError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.stage, expectedStage);
    assert.equal(error.status, expectedStatus);
    assert.equal(error.message.includes(sensitiveApiText), false);
    assert.equal(error.message.includes('redacted-testing-token'), false);
    assert.equal(error.message.includes('a'.repeat(32)), false);
    return true;
  });
}
for (const [status, code] of [
  [401, 'AUTHENTICATION_FAILED'],
  [403, 'READ_PERMISSION_DENIED'],
  [404, 'RESOURCE_ENDPOINT_NOT_FOUND'],
  [429, 'CLOUDFLARE_RATE_LIMITED'],
  [503, 'HTTP_REQUEST_FAILED'],
]) {
  await assertSafeFailure(
    async () => Response.json({ success: false, errors: [{ message: sensitiveApiText }] }, { status }),
    code,
    'worker-list',
    status,
  );
}
await assertSafeFailure(
  async () => {
    throw new Error(sensitiveApiText);
  },
  'NETWORK_OR_TIMEOUT',
  'worker-list',
);
await assertSafeFailure(
  async () => Response.json({ success: false, errors: [{ message: sensitiveApiText }] }),
  'API_RESPONSE_REJECTED',
  'worker-list',
);
await assertSafeFailure(async () => new Response(sensitiveApiText, { status: 200 }), 'INVALID_API_JSON', 'worker-list');
await assertSafeFailure(async () => Response.json({ success: false }, { status: 403 }), 'READ_PERMISSION_DENIED', 'account-zones', 403, 'zones');
await assertSafeFailure(async () => Response.json({ success: false }, { status: 403 }), 'READ_PERMISSION_DENIED', 'worker-domains', 403, 'domains');
assert.throws(
  () => createReadOnlyCloudflareClient({ accountId: 'invalid', token: 'invalid' }),
  (error) => error instanceof InventoryDiagnosticError && error.code === 'INVALID_CREDENTIAL_METADATA' && error.stage === 'configuration',
);

const mock = makeFetch();
const client = createReadOnlyCloudflareClient({ accountId: 'a'.repeat(32), token: 'mock-read-only-token-123', fetchImpl: mock.fetchImpl });
const report = await inspectProductionWorkers(client);

assert.equal(report.metadata_consistency, 'pass');
assert.equal(report.cron_phase, 'prepare');
assert.equal(report.production_cutover_approved, false);
assert.deepEqual(report.access_requirement.api_token_permissions, ['Zone Read', 'Workers Routes Read', 'Workers Scripts Read']);
assert.equal(report.access_requirement.secret_values_requested_or_reported, false);
assert.equal(report.checks.shared_token_stats_d1_consistent, true);
assert.equal(report.checks.declared_build_sha_consistent, true);
assert.equal(report.workers['ai-gateway'].declared_build_sha, BUILD_SHA);
assert.equal(report.checks.tier1_kv_binding_present, true);
assert.equal(report.checks.gateway_provider_credential_binding_count, 0);
assert.equal(report.checks.account_zone_count_scanned, 51);
assert.equal(report.workers['ai-gateway'].active_traffic_version_count, 1);
assert.equal(report.workers['ai-gateway'].exposure.worker_route_count, 1);
assert.equal(report.workers['ai-gateway'].exposure.enabled_custom_domain_count, 1);
assert.deepEqual(report.workers['ai-gateway'].secret_names, [
  'AIG_ACCESS_KEY_AIR',
  'AIG_GENERATION_AUTH_KEY',
  'AIG_INFERENCE_AUTH_KEY',
  'AIG_PERCEPTION_AUTH_KEY',
]);
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
const domainCalls = mock.calls.filter((call) => new URL(call.url).pathname.endsWith('/workers/domains'));
assert.equal(domainCalls.length, WORKERS.length, 'Each target Worker domain list must be queried');
assert.deepEqual(
  domainCalls.map((call) => new URL(call.url).searchParams.get('service')).sort(),
  [...WORKERS].sort(),
  'Worker Domains requests must be scoped to each target Worker',
);
assert.equal(
  mock.calls.some((call) => new URL(call.url).pathname.endsWith('/workers/scripts') && new URL(call.url).search),
  false,
);

const shortIntermediateZoneMock = makeFetch({ zonePageOneCount: 49 });
await assert.rejects(
  inspectProductionWorkers(
    createReadOnlyCloudflareClient({
      accountId: 'a'.repeat(32),
      token: 'mock-read-only-token-123',
      fetchImpl: shortIntermediateZoneMock.fetchImpl,
    }),
  ),
  /incomplete before the reported final page/,
);

const missingZonePaginationMock = makeFetch({ zonePageInfo: { 1: { total_count: undefined } } });
await assert.rejects(
  inspectProductionWorkers(
    createReadOnlyCloudflareClient({
      accountId: 'a'.repeat(32),
      token: 'mock-read-only-token-123',
      fetchImpl: missingZonePaginationMock.fetchImpl,
    }),
  ),
  /pagination metadata is incomplete/,
);

const truncatedZonePaginationMock = makeFetch({ zonePageInfo: { 1: { total_pages: 1 } } });
await assert.rejects(
  inspectProductionWorkers(
    createReadOnlyCloudflareClient({
      accountId: 'a'.repeat(32),
      token: 'mock-read-only-token-123',
      fetchImpl: truncatedZonePaginationMock.fetchImpl,
    }),
  ),
  /did not match the reported total count/,
);

const changingZoneTotalMock = makeFetch({ zonePageInfo: { 2: { total_count: 52 } } });
await assert.rejects(
  inspectProductionWorkers(
    createReadOnlyCloudflareClient({
      accountId: 'a'.repeat(32),
      token: 'mock-read-only-token-123',
      fetchImpl: changingZoneTotalMock.fetchImpl,
    }),
  ),
  /total count changed during inventory/,
);

const missingBuildShaSettings = structuredClone(BASE_SETTINGS);
missingBuildShaSettings['ai-gateway-operations'] = missingBuildShaSettings['ai-gateway-operations'].filter(
  (binding) => binding.name !== 'AIG_BUILD_SHA',
);
const missingBuildShaReport = await inspectProductionWorkers(
  createReadOnlyCloudflareClient({
    accountId: 'a'.repeat(32),
    token: 'mock-read-only-token-123',
    fetchImpl: makeFetch({ settings: missingBuildShaSettings }).fetchImpl,
  }),
);
assert.ok(missingBuildShaReport.blockers.includes('WORKER_DECLARED_SHA_MISSING:ai-gateway-operations'));
assert.ok(missingBuildShaReport.blockers.includes('WORKER_DECLARED_SHA_MISMATCH'));

const divergentBuildSettings = structuredClone(BASE_SETTINGS);
divergentBuildSettings['ai-generation-center'][0].text = 'b'.repeat(40);
const divergentBuildReport = await inspectProductionWorkers(
  createReadOnlyCloudflareClient({
    accountId: 'a'.repeat(32),
    token: 'mock-read-only-token-123',
    fetchImpl: makeFetch({ settings: divergentBuildSettings }).fetchImpl,
  }),
);
assert.ok(divergentBuildReport.blockers.includes('WORKER_DECLARED_SHA_MISMATCH'));
assert.equal(divergentBuildReport.checks.declared_build_sha_consistent, false);

const malformedBuildSettings = structuredClone(BASE_SETTINGS);
malformedBuildSettings['ai-inference-center'][0].text = 'not-a-sha';
await assert.rejects(
  inspectProductionWorkers(
    createReadOnlyCloudflareClient({
      accountId: 'a'.repeat(32),
      token: 'mock-read-only-token-123',
      fetchImpl: makeFetch({ settings: malformedBuildSettings }).fetchImpl,
    }),
  ),
  /Invalid declared Worker source SHA metadata/,
);

const arbitraryTextSecret = 'plain-text-vars-must-stay-private';
const isolatedSettings = structuredClone(BASE_SETTINGS);
isolatedSettings['ai-inference-center'].push({ name: 'AIG_PUBLIC_URL', type: 'plain_text', text: arbitraryTextSecret });
const isolatedReport = await inspectProductionWorkers(
  createReadOnlyCloudflareClient({
    accountId: 'a'.repeat(32),
    token: 'mock-read-only-token-123',
    fetchImpl: makeFetch({ settings: isolatedSettings }).fetchImpl,
  }),
);
assert.ok(!JSON.stringify(isolatedReport).includes(arbitraryTextSecret));

const missingGatewayRouteMock = makeFetch({ routesByWorker: {}, domainsByService: { 'ai-gateway': [] } });
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
  /Secret key material is not permitted/,
);

const secretKeyValueMock = makeFetch({
  settings: {
    ...structuredClone(BASE_SETTINGS),
    'ai-generation-center': [{ name: 'AIG_GENERATION_KEY', type: 'secret_key', key_jwk: { private_key_must_not_leak: SECRET_SENTINEL } }],
  },
});
await assert.rejects(
  inspectProductionWorkers(
    createReadOnlyCloudflareClient({
      accountId: 'a'.repeat(32),
      token: 'mock-read-only-token-123',
      fetchImpl: secretKeyValueMock.fetchImpl,
    }),
  ),
  /Secret key material is not permitted/,
);
assert.equal(JSON.stringify(secretKeyValueMock.calls).includes(SECRET_SENTINEL), false);

const duplicateSecretMock = makeFetch({
  settings: {
    ...structuredClone(BASE_SETTINGS),
    'ai-inference-center': [
      { name: 'AIG_INFERENCE_AUTH_KEY', type: 'secret_text' },
      { name: 'AIG_INFERENCE_AUTH_KEY', type: 'secret_text' },
    ],
  },
});
await assert.rejects(
  inspectProductionWorkers(
    createReadOnlyCloudflareClient({
      accountId: 'a'.repeat(32),
      token: 'mock-read-only-token-123',
      fetchImpl: duplicateSecretMock.fetchImpl,
    }),
  ),
  /Duplicate Worker binding metadata/,
);

const privateRouteMock = makeFetch({ routesByWorker: { 'ai-inference-center': [{ id: 'r-private', pattern: '*', script: 'ai-inference-center' }] } });
const privateRouteReport = await inspectProductionWorkers(
  createReadOnlyCloudflareClient({ accountId: 'a'.repeat(32), token: 'mock-read-only-token-123', fetchImpl: privateRouteMock.fetchImpl }),
);
assert.ok(privateRouteReport.blockers.includes('PRIVATE_WORKER_EXPOSED:ai-inference-center'));

const privateDomainMock = makeFetch({
  domainsByService: { 'ai-inference-center': [makeDomain('domain-inference', 'ai-inference-center', true, false)] },
});
const privateDomainReport = await inspectProductionWorkers(
  createReadOnlyCloudflareClient({
    accountId: 'a'.repeat(32),
    token: 'mock-read-only-token-123',
    fetchImpl: privateDomainMock.fetchImpl,
  }),
);
assert.ok(privateDomainReport.blockers.includes('PRIVATE_WORKER_EXPOSED:ai-inference-center'));

const incompleteDomainMock = makeFetch({
  domainResultInfo: { 'ai-generation-center': { total_pages: 2 } },
});
await assert.rejects(
  inspectProductionWorkers(
    createReadOnlyCloudflareClient({
      accountId: 'a'.repeat(32),
      token: 'mock-read-only-token-123',
      fetchImpl: incompleteDomainMock.fetchImpl,
    }),
  ),
  /does not accept page parameters/,
);

const truncatedDomainMock = makeFetch({
  domainsByService: { 'ai-generation-center': [] },
  domainResultInfo: { 'ai-generation-center': { total_count: 1 } },
});
await assert.rejects(
  inspectProductionWorkers(
    createReadOnlyCloudflareClient({
      accountId: 'a'.repeat(32),
      token: 'mock-read-only-token-123',
      fetchImpl: truncatedDomainMock.fetchImpl,
    }),
  ),
  /Worker domain result is incomplete/,
);

const unsafeMock = makeFetch({
  cron: {
    'ai-gateway': ['0 3 * * *'],
    'ai-inference-center': [],
    'ai-perception-center': [],
    'ai-generation-center': [],
    'ai-gateway-operations': ['0 3 * * *'],
  },
  settings: {
    ...structuredClone(BASE_SETTINGS),
    'ai-gateway-operations': [
      { name: 'TOKEN_STATS_DB', type: 'd1', database_id: '123e4567-e89b-42d3-a456-426614174099' },
      { name: 'AIG_TIER1_CREDENTIALS_01', type: 'secret_text' },
    ],
    'ai-gateway': [...BASE_SETTINGS['ai-gateway'], { name: 'AIG_TIER2_CREDENTIALS', type: 'secret_text' }],
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

const retiredBindingMock = makeFetch({
  settings: {
    ...structuredClone(BASE_SETTINGS),
    'ai-gateway': [
      ...BASE_SETTINGS['ai-gateway'],
      { name: 'AIG_IS_SUBSCRIPTION_ENABLED', type: 'plain_text', text: 'must-not-appear-in-report' },
      { name: 'AIG_OAUTH_ADMIN_GROUPS', type: 'secret_text' },
      { name: 'AIG_TIER3_NODES_01', type: 'secret_text' },
    ],
  },
});
const retiredBindingReport = await inspectProductionWorkers(
  createReadOnlyCloudflareClient({
    accountId: 'a'.repeat(32),
    token: 'mock-read-only-token-123',
    fetchImpl: retiredBindingMock.fetchImpl,
  }),
);
assert.ok(retiredBindingReport.blockers.includes('RETIRED_BINDINGS_PRESENT:ai-gateway'));
assert.equal(JSON.stringify(retiredBindingReport).includes('must-not-appear-in-report'), false);

const customCronMock = makeFetch({
  cron: {
    'ai-gateway': ['17 4 * * 2'],
    'ai-inference-center': [],
    'ai-perception-center': [],
    'ai-generation-center': [],
    'ai-gateway-operations': [],
  },
});
const customCronReport = await inspectProductionWorkers(
  createReadOnlyCloudflareClient({
    accountId: 'a'.repeat(32),
    token: 'mock-read-only-token-123',
    fetchImpl: customCronMock.fetchImpl,
  }),
);
assert.equal(customCronReport.cron_phase, 'prepare', 'Cron ownership detection must not hardcode the schedule expression');

assert.throws(
  () => createReadOnlyCloudflareClient({ accountId: 'invalid', token: 'mock-read-only-token-123', fetchImpl: mock.fetchImpl }),
  /INVALID_CREDENTIAL_METADATA/,
);

console.log(
  'Cloudflare live inventory contract passed: GET-only, documented pagination, safe Secret metadata, complete route checks, and fail-closed ownership detection.',
);
