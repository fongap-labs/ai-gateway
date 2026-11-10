#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Read-only Cloudflare inventory for the four-Worker production cutover.
// Use a Workers Metadata Read-Only token. Never call the Secrets API: its list
// response includes Secret values. Only binding names/types are projected.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKERS = ['ai-gateway', 'ai-inference-center', 'ai-generation-center', 'ai-gateway-operations'];
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const RESOURCE_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const RETIRED = /^(?:AIG_TIER3_|AIG_OAUTH_|AIG_IS_SUBSCRIPTION_ENABLED$|AIG_TOKEN_ENCRYPTION_KEY$)/;
const PROVIDER_CREDENTIAL = /^AIG_TIER\d+_CREDENTIALS(?:_|$)/;
const SECRET_TYPES = new Set(['secret_text', 'secret_key']);
const ZONE_PAGE_SIZE = 50;
const MAX_ZONE_PAGES = 100;

function assertRecords(items, label) {
  if (!Array.isArray(items) || !items.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
    throw new Error('Invalid remote ' + label + ' metadata.');
  }
}

function sortedUnique(names, label) {
  if (new Set(names).size !== names.length) throw new Error('Duplicate ' + label + ' metadata.');
  return [...names].sort();
}

function query(page, perPage) {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  return '?' + params.toString();
}

function validatePageInfo(info, page, perPage, label, resultCount) {
  if (info === undefined) return { totalPages: null };
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Invalid ' + label + ' pagination.');
  if (page !== null && page !== undefined && info.page !== undefined && info.page !== page) {
    throw new Error('Unexpected ' + label + ' page.');
  }
  if (perPage !== null && perPage !== undefined && info.per_page !== undefined && info.per_page !== perPage) {
    throw new Error('Unexpected ' + label + ' page size.');
  }
  if (info.count !== undefined && (!Number.isInteger(info.count) || info.count < 0 || info.count !== resultCount)) {
    throw new Error('Unexpected ' + label + ' result count.');
  }
  if (info.total_count !== undefined && (!Number.isInteger(info.total_count) || info.total_count < 0)) {
    throw new Error('Invalid ' + label + ' total count.');
  }
  if (info.total_pages !== undefined && (!Number.isInteger(info.total_pages) || info.total_pages < 0)) {
    throw new Error('Invalid ' + label + ' page count.');
  }
  return { totalPages: info.total_pages ?? null };
}

export function createReadOnlyCloudflareClient({ accountId, token, fetchImpl = fetch }) {
  if (!ACCOUNT_ID.test(accountId || '') || typeof token !== 'string' || token.length < 16) {
    throw new Error('Cloudflare inventory requires protected read-only credentials.');
  }

  async function get(endpoint) {
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/') || endpoint.startsWith('//')) {
      throw new Error('Invalid Cloudflare inventory endpoint.');
    }
    const path = /^\/zones(?:\/|\?)/.test(endpoint) ? endpoint : '/accounts/' + accountId + endpoint;
    const url = 'https://api.cloudflare.com/client/v4' + path;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response?.ok) throw new Error('Cloudflare read-only inventory request failed.');
    const body = await response.json().catch(() => null);
    if (body?.success !== true || !Object.hasOwn(body, 'result')) {
      throw new Error('Cloudflare read-only inventory response was invalid.');
    }
    return { result: body.result, info: body.result_info };
  }

  return {
    async scripts() {
      // The official Scripts list endpoint accepts a tags filter, not page or
      // per_page. Treat it as one complete result and reject pagination hints
      // that would make completeness ambiguous.
      const response = await get('/workers/scripts');
      assertRecords(response.result, 'Worker list');
      if (
        response.info?.total_count !== undefined &&
        (!Number.isInteger(response.info.total_count) || response.info.total_count !== response.result.length)
      ) {
        throw new Error('Worker list completeness could not be verified.');
      }
      if (
        response.info?.total_pages !== undefined &&
        (!Number.isInteger(response.info.total_pages) ||
          response.info.total_pages > 1 ||
          (response.info.total_pages === 0 && response.result.length > 0))
      ) {
        throw new Error('Worker list pagination metadata was unexpected.');
      }
      const names = response.result.map((item) => {
        if (typeof item.id !== 'string' || item.id.length === 0) throw new Error('Invalid Worker identity.');
        return item.id;
      });
      sortedUnique(names, 'Worker identity');
      return response.result.map((item) => ({ name: item.id }));
    },

    async zones() {
      const zones = [];
      const seen = new Set();
      let expectedTotalPages = null;
      for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
        const params = new URLSearchParams({ 'account.id': accountId, page: String(page), per_page: String(ZONE_PAGE_SIZE) });
        const response = await get('/zones?' + params.toString());
        assertRecords(response.result, 'account zone list');
        for (const zone of response.result) {
          if (
            typeof zone.id !== 'string' ||
            !ACCOUNT_ID.test(zone.id) ||
            typeof zone.account?.id !== 'string' ||
            zone.account.id.toLowerCase() !== accountId.toLowerCase()
          ) {
            throw new Error('Invalid account zone metadata.');
          }
          if (seen.has(zone.id)) throw new Error('Duplicate account zone metadata.');
          seen.add(zone.id);
          zones.push(zone.id);
        }
        const { totalPages } = validatePageInfo(response.info, page, ZONE_PAGE_SIZE, 'account zones', response.result.length);
        if (totalPages !== null) {
          if (totalPages === 0) {
            if (response.result.length > 0 || page !== 1) throw new Error('Invalid account zone pagination.');
            return zones;
          }
          if (expectedTotalPages !== null && expectedTotalPages !== totalPages) {
            throw new Error('Account zone pagination changed during inventory.');
          }
          expectedTotalPages = totalPages;
          if (page > totalPages) throw new Error('Account zone pagination exceeded the reported page count.');
          if (totalPages > page && response.result.length !== ZONE_PAGE_SIZE) {
            throw new Error('Account zone page was incomplete before the reported final page.');
          }
          if (page === totalPages) {
            if (totalPages > 0 && response.result.length === 0) throw new Error('Account zone final page was empty.');
            return zones;
          }
        } else if (response.result.length < ZONE_PAGE_SIZE) {
          return zones;
        }
      }
      throw new Error('Account zone inventory exceeded bounded pagination.');
    },

    async routes(zoneIds) {
      if (!Array.isArray(zoneIds) || !zoneIds.every((id) => typeof id === 'string' && ACCOUNT_ID.test(id))) {
        throw new Error('Invalid account zone identities.');
      }
      const counts = Object.fromEntries(WORKERS.map((name) => [name, 0]));
      const routeIds = new Set();
      for (const zoneId of zoneIds) {
        const response = await get('/zones/' + encodeURIComponent(zoneId) + '/workers/routes');
        assertRecords(response.result, 'zone Worker routes');
        for (const route of response.result) {
          if (typeof route.id !== 'string' || typeof route.pattern !== 'string' || (route.script !== undefined && typeof route.script !== 'string')) {
            throw new Error('Invalid zone Worker route metadata.');
          }
          const routeKey = zoneId + ':' + route.id;
          if (routeIds.has(routeKey)) throw new Error('Duplicate zone Worker route metadata.');
          routeIds.add(routeKey);
          if (Object.hasOwn(counts, route.script)) counts[route.script] += 1;
        }
      }
      return { counts, zoneCount: zoneIds.length };
    },

    async domains() {
      const domains = [];
      const seen = new Set();
      for (const worker of WORKERS) {
        // The official SDK models this endpoint as SinglePage and its documented
        // query parameters are filters, not page/per_page. Scope each request to
        // one target Worker and fail closed if the API reports multiple pages.
        const params = new URLSearchParams({ service: worker });
        const response = await get('/workers/domains?' + params.toString());
        assertRecords(response.result, 'Worker domains');
        for (const domain of response.result) {
          if (
            typeof domain.id !== 'string' ||
            domain.service !== worker ||
            typeof domain.enabled !== 'boolean' ||
            typeof domain.previews_enabled !== 'boolean'
          ) {
            throw new Error('Invalid Worker domain metadata.');
          }
          if (seen.has(domain.id)) throw new Error('Duplicate Worker domain metadata.');
          seen.add(domain.id);
          // Keep only routing metadata needed for exposure checks. Hostnames,
          // zone IDs, certificate IDs, and domain IDs never enter the report.
          domains.push({ service: domain.service, enabled: domain.enabled, previewsEnabled: domain.previews_enabled });
        }
        const { totalPages } = validatePageInfo(response.info, 1, null, 'Worker domains', response.result.length);
        if (totalPages !== null && totalPages > 1) {
          throw new Error('Worker domain result is paginated but the documented endpoint does not accept page parameters.');
        }
        if (totalPages === 0 && response.result.length > 0) throw new Error('Invalid Worker domain pagination.');
      }
      return domains;
    },

    async worker(name) {
      if (!WORKERS.includes(name)) throw new Error('Unapproved Worker identity.');
      const prefix = '/workers/scripts/' + encodeURIComponent(name);
      const rawBindings = await (async () => {
        const settings = (await get(prefix + '/settings')).result;
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
          throw new Error('Invalid Worker settings.');
        }
        const settingsBindings = settings.bindings ?? [];
        assertRecords(settingsBindings, 'Worker bindings');
        return settingsBindings.map((binding) => {
          if (typeof binding.name !== 'string' || !SECRET_NAME.test(binding.name) || typeof binding.type !== 'string' || binding.type.length === 0) {
            throw new Error('Invalid Worker binding metadata.');
          }
          if (SECRET_TYPES.has(binding.type) && ['text', 'key_base64', 'key_jwk'].some((field) => Object.hasOwn(binding, field))) {
            throw new Error('Secret key material is not permitted in Worker settings metadata.');
          }
          const projected = { name: binding.name, type: binding.type };
          if (binding.type === 'service' && typeof binding.service === 'string') projected.service = binding.service;
          if (binding.type === 'd1') {
            if (typeof binding.database_id === 'string') projected.database_id = binding.database_id;
            else if (typeof binding.id === 'string') projected.id = binding.id;
          }
          if (binding.name === 'TIER1_AFFINITY' && binding.type === 'kv_namespace') {
            if (typeof binding.namespace_id === 'string') projected.namespace_id = binding.namespace_id;
            else if (typeof binding.id === 'string') projected.id = binding.id;
          }
          return projected;
        });
      })();
      sortedUnique(
        rawBindings.map((binding) => binding.name),
        'Worker binding',
      );

      const bindings = rawBindings.map((binding) => {
        const item = { name: binding.name, type: binding.type };
        if (binding.type === 'service' && typeof binding.service === 'string') item.service = binding.service;
        return item;
      });
      // Secret values are intentionally not queried. Settings expose binding
      // metadata; only Secret binding names/types are retained from that view.
      const secretNames = sortedUnique(
        rawBindings.filter((binding) => SECRET_TYPES.has(binding.type)).map((binding) => binding.name),
        'Worker Secret name',
      );

      const scheduleResult = (await get(prefix + '/schedules')).result;
      assertRecords(scheduleResult?.schedules, 'Worker Cron');
      const cron = scheduleResult.schedules.map((item) => {
        if (typeof item.cron !== 'string' || item.cron.length === 0) throw new Error('Invalid Worker Cron.');
        return item.cron;
      });

      const subdomain = (await get(prefix + '/subdomain')).result;
      if (typeof subdomain?.enabled !== 'boolean' || typeof subdomain?.previews_enabled !== 'boolean') {
        throw new Error('Invalid Worker public subdomain metadata.');
      }

      const deploymentResponse = await get(prefix + '/deployments' + query(1, 1));
      const deploymentResult = deploymentResponse.result;
      assertRecords(deploymentResult?.deployments, 'Worker deployments');
      const { totalPages: deploymentPages } = validatePageInfo(
        deploymentResponse.info,
        1,
        1,
        'Worker deployments',
        deploymentResult.deployments.length,
      );
      if (deploymentPages === 0 && deploymentResult.deployments.length > 0) {
        throw new Error('Invalid Worker deployment pagination.');
      }
      const active = deploymentResult.deployments[0] ?? null;
      let activeDeployment = { present: false, versionCount: 0, trafficWeightTotal: 0 };
      if (active) {
        if (typeof active.id !== 'string' || active.id.length === 0) throw new Error('Invalid Worker deployment metadata.');
        assertRecords(active.versions, 'Worker deployment versions');
        let trafficWeightTotal = 0;
        for (const version of active.versions) {
          if (
            typeof version.version_id !== 'string' ||
            typeof version.percentage !== 'number' ||
            !Number.isFinite(version.percentage) ||
            version.percentage < 0 ||
            version.percentage > 100
          ) {
            throw new Error('Invalid Worker deployment version metadata.');
          }
          trafficWeightTotal += version.percentage;
        }
        activeDeployment = {
          present: true,
          versionCount: active.versions.length,
          trafficWeightTotal,
        };
      }

      const d1Bindings = rawBindings.filter((binding) => binding.type === 'd1');
      const tokenStats = d1Bindings.filter((binding) => binding.name === 'TOKEN_STATS_DB');
      const d1Id = tokenStats.length === 1 ? (tokenStats[0].database_id ?? tokenStats[0].id ?? null) : null;
      const kvBindings = rawBindings.filter((binding) => binding.name === 'TIER1_AFFINITY' && binding.type === 'kv_namespace');
      const kvId = kvBindings.length === 1 ? (kvBindings[0].namespace_id ?? kvBindings[0].id ?? null) : null;
      const serviceTargets = rawBindings
        .filter((binding) => binding.type === 'service')
        .map((binding) => ({ name: binding.name, service: typeof binding.service === 'string' ? binding.service : null }));

      return {
        bindings,
        secretNames,
        retiredNames: sortedUnique(
          rawBindings.map((binding) => binding.name).filter((name) => RETIRED.test(name)),
          'retired binding',
        ),
        providerCredentialNames: sortedUnique(
          rawBindings.map((binding) => binding.name).filter((name) => PROVIDER_CREDENTIAL.test(name)),
          'Provider credential binding',
        ),
        cron,
        workersDev: subdomain.enabled,
        previewsEnabled: subdomain.previews_enabled,
        activeDeployment,
        d1BindingCount: d1Bindings.length,
        tokenStatsDbCount: tokenStats.length,
        d1IdentityPresent: typeof d1Id === 'string' && RESOURCE_ID.test(d1Id),
        d1Identity: typeof d1Id === 'string' && RESOURCE_ID.test(d1Id) ? d1Id : null,
        tier1KvBindingCount: kvBindings.length,
        tier1KvIdentityPresent: typeof kvId === 'string' && RESOURCE_ID.test(kvId),
        serviceTargets,
      };
    },
  };
}

function publicExposure(name, worker, routeCount, domains) {
  const matches = domains.filter((domain) => domain.service === name);
  return {
    workers_dev: worker.workersDev,
    previews_enabled: worker.previewsEnabled,
    worker_route_count: routeCount,
    custom_domain_count: matches.length,
    enabled_custom_domain_count: matches.filter((domain) => domain.enabled).length,
    preview_custom_domain_count: matches.filter((domain) => domain.previewsEnabled).length,
  };
}

function activeDeploymentReady(active) {
  return active.present && active.versionCount > 0 && Math.abs(active.trafficWeightTotal - 100) < 0.001;
}

export async function inspectProductionWorkers(client) {
  const scripts = await client.scripts();
  const scriptByName = new Map(scripts.map((item) => [item.name, item]));
  if (scriptByName.size !== scripts.length) throw new Error('Duplicate Worker identity metadata.');
  const zones = await client.zones();
  const routeInventory = await client.routes(zones);
  const domains = await client.domains();
  const observed = {};
  for (const name of WORKERS) {
    observed[name] = scriptByName.has(name) ? await client.worker(name) : null;
  }

  const issues = [];
  const inventory = {};
  for (const name of WORKERS) {
    const worker = observed[name];
    if (!worker) {
      inventory[name] = { deployed: false };
      issues.push('WORKER_NOT_DEPLOYED:' + name);
      continue;
    }
    if (!activeDeploymentReady(worker.activeDeployment)) issues.push('WORKER_ACTIVE_DEPLOYMENT_INVALID:' + name);
    if (worker.retiredNames.length) issues.push('RETIRED_BINDINGS_PRESENT:' + name);
    if (name === 'ai-gateway' && worker.providerCredentialNames.length > 0) {
      issues.push('GATEWAY_PROVIDER_CREDENTIALS_PRESENT');
    }
    if (name === 'ai-gateway-operations' && worker.providerCredentialNames.length > 0) {
      issues.push('OPERATIONS_PROVIDER_CREDENTIALS_PRESENT');
    }
    const exposure = publicExposure(name, worker, routeInventory.counts[name], domains);
    if (
      name !== 'ai-gateway' &&
      (exposure.workers_dev ||
        exposure.previews_enabled ||
        exposure.worker_route_count > 0 ||
        exposure.enabled_custom_domain_count > 0 ||
        exposure.preview_custom_domain_count > 0)
    ) {
      issues.push('PRIVATE_WORKER_EXPOSED:' + name);
    }
    inventory[name] = {
      deployed: true,
      active_deployment_present: worker.activeDeployment.present,
      active_traffic_version_count: worker.activeDeployment.versionCount,
      active_traffic_weight_total: worker.activeDeployment.trafficWeightTotal,
      bindings: worker.bindings,
      secret_names: worker.secretNames,
      retired_binding_names: worker.retiredNames,
      provider_credential_binding_names: worker.providerCredentialNames,
      crons: worker.cron,
      exposure,
      d1_binding_count: worker.d1BindingCount,
      token_stats_db_binding_count: worker.tokenStatsDbCount,
      d1_identity_present: worker.d1IdentityPresent,
      tier1_kv_binding_count: worker.tier1KvBindingCount,
      tier1_kv_identity_present: worker.tier1KvIdentityPresent,
    };
  }

  const gateway = observed['ai-gateway'];
  const inference = observed['ai-inference-center'];
  const generation = observed['ai-generation-center'];
  const operations = observed['ai-gateway-operations'];
  const services = gateway?.serviceTargets ?? [];
  const serviceChecks = {};
  for (const [binding, service] of [
    ['AIG_INFERENCE_SERVICE', 'ai-inference-center'],
    ['AIG_GENERATION_SERVICE', 'ai-generation-center'],
  ]) {
    const matches = services.filter((target) => target.name === binding);
    const valid = matches.length === 1 && matches[0].service === service;
    serviceChecks[binding] = valid;
    if (!valid) issues.push('GATEWAY_SERVICE_BINDING_MISMATCH:' + binding);
  }

  const tier1KvPresent = gateway?.tier1KvBindingCount === 1 && gateway.tier1KvIdentityPresent;
  if (gateway && !tier1KvPresent) issues.push('GATEWAY_TIER1_KV_MISSING_OR_INVALID');

  const gatewayExposure = gateway ? publicExposure('ai-gateway', gateway, routeInventory.counts['ai-gateway'], domains) : null;
  const gatewayPublicRoutePresent = Boolean(
    gatewayExposure && (gatewayExposure.workers_dev || gatewayExposure.worker_route_count > 0 || gatewayExposure.enabled_custom_domain_count > 0),
  );
  if (gateway && !gatewayPublicRoutePresent) issues.push('GATEWAY_PUBLIC_ROUTE_MISSING');

  const d1Valid = (worker) => worker?.d1BindingCount === 1 && worker.tokenStatsDbCount === 1 && worker.d1IdentityPresent;
  const sharedD1 = Boolean(d1Valid(gateway) && d1Valid(operations) && gateway.d1Identity.toLowerCase() === operations.d1Identity.toLowerCase());
  if (gateway && operations && !sharedD1) issues.push('SHARED_D1_MISMATCH');
  if (gateway && !d1Valid(gateway)) issues.push('GATEWAY_D1_BINDING_INVALID');
  if (operations && !d1Valid(operations)) issues.push('OPERATIONS_D1_BINDING_INVALID');

  for (const [name, worker] of [
    ['ai-inference-center', inference],
    ['ai-generation-center', generation],
  ]) {
    if (worker && worker.cron.length > 0) issues.push('UNEXPECTED_CENTER_CRON:' + name);
  }

  const gatewayCron = gateway?.cron;
  const operationsCron = operations?.cron;
  let cronPhase = 'incomplete';
  if (gatewayCron && operationsCron) {
    if (gatewayCron.length === 1 && operationsCron.length === 0) cronPhase = 'prepare';
    else if (gatewayCron.length === 0 && operationsCron.length === 0) cronPhase = 'detach';
    else if (gatewayCron.length === 0 && operationsCron.length === 1) cronPhase = 'activate';
    else {
      cronPhase = 'unsafe';
      issues.push('CRON_OWNERSHIP_UNSAFE');
    }
  }

  return {
    report_type: 'cloudflare_read_only_inventory',
    access_requirement: {
      api_token_permissions: ['Zone Read', 'Workers Routes Read', 'Workers Scripts Read'],
      secret_values_requested_or_reported: false,
    },
    production_cutover_approved: false,
    workers: inventory,
    checks: {
      gateway_service_bindings: serviceChecks,
      account_zone_count_scanned: routeInventory.zoneCount,
      gateway_public_route_present: gatewayPublicRoutePresent,
      tier1_kv_binding_present: tier1KvPresent,
      shared_token_stats_d1_consistent: sharedD1,
      gateway_provider_credential_binding_count: gateway?.providerCredentialNames.length ?? null,
      private_worker_exposure_clear:
        Boolean(inference && generation && operations) && issues.every((issue) => !issue.startsWith('PRIVATE_WORKER_EXPOSED:')),
    },
    cron_phase: cronPhase,
    metadata_consistency: issues.length === 0 ? 'pass' : 'blocked',
    blockers: sortedUnique(issues, 'inventory blocker'),
    unverified: [
      'provider-secret-values-and-credential-functionality',
      'node-json-oauth-markers-and-migration-conflicts',
      'four-worker-build-sha-equality',
      'runtime-health-and-request-metrics',
      'global-cron-propagation-and-independent-runtime-evidence',
      'rollback-drill',
    ],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 0 && !(argv.length === 2 && argv[0] === '--out' && argv[1])) {
    throw new Error('usage: cloudflare-live-inventory.mjs [--out PRIVATE_FILE]');
  }
  const client = createReadOnlyCloudflareClient({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  });
  const report = await inspectProductionWorkers(client);
  if (argv.length === 2) {
    // Contains resource names and routing metadata only; never overwrite.
    fs.writeFileSync(argv[1], JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const summary = {
    report_type: report.report_type,
    inspected_worker_count: Object.values(report.workers).filter((worker) => worker.deployed).length,
    cron_phase: report.cron_phase,
    metadata_consistency: report.metadata_consistency,
    blockers: report.blockers,
    unverified: report.unverified,
    production_cutover_approved: false,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
  if (report.metadata_consistency !== 'pass') process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Cloudflare inventory refused; inspect protected read-only credentials or API permissions. No changes made.');
    process.exitCode = 2;
  });
}

