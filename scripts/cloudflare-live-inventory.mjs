#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Read-only Cloudflare inventory for the four-Worker production cutover.
// Always project API results to safe metadata; never retain or emit values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKERS = ['ai-gateway', 'ai-inference-center', 'ai-generation-center', 'ai-gateway-operations'];
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const RETIRED = /^(?:AIG_TIER3_|AIG_OAUTH_|AIG_IS_SUBSCRIPTION_ENABLED$|AIG_TOKEN_ENCRYPTION_KEY$)/;
const NODE_CREDENTIAL = /^AIG_TIER[12]_CREDENTIALS_(0[1-9]|10)$/;
const MAINTENANCE = '0 3 * * *';

function assertRecords(items, label) {
  if (!Array.isArray(items) || !items.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
    throw new Error('Invalid remote ' + label + ' metadata.');
  }
}
function unique(names, label) {
  if (new Set(names).size !== names.length) throw new Error('Duplicate ' + label + ' metadata.');
  return names;
}

export function createReadOnlyCloudflareClient({ accountId, token, fetchImpl = fetch }) {
  if (!ACCOUNT_ID.test(accountId || '') || typeof token !== 'string' || token.length < 16) {
    throw new Error('Cloudflare inventory requires protected read-only credentials.');
  }
  async function get(endpoint) {
    const url = ['https://api.cloudflare.com/client/v4/accounts', accountId, 'workers/scripts'].join('/') + endpoint;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + token },
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
      const ids = [];
      for (let page = 1; page <= 20; page += 1) {
        const response = await get('?page=' + page + '&per_page=100');
        assertRecords(response.result, 'Worker list');
        for (const item of response.result) {
          if (typeof item.id !== 'string') throw new Error('Invalid Worker identity.');
          ids.push(item.id);
        }
        if (response.info?.total_pages !== undefined) {
          if (!Number.isInteger(response.info.total_pages) || response.info.total_pages < page) {
            throw new Error('Invalid Worker list pagination.');
          }
          if (page >= response.info.total_pages) return unique(ids, 'Worker identity');
        } else if (response.result.length < 100) {
          return unique(ids, 'Worker identity');
        }
      }
      throw new Error('Worker inventory exceeded bounded pagination.');
    },
    async worker(name) {
      if (!WORKERS.includes(name)) throw new Error('Unapproved Worker identity.');
      const prefix = '/' + name;
      const settings = (await get(prefix + '/settings')).result;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error('Invalid Worker settings.');
      }
      assertRecords(settings.bindings, 'Worker bindings');
      const bindings = settings.bindings.map((binding) => {
        if (typeof binding.name !== 'string' || typeof binding.type !== 'string') {
          throw new Error('Invalid Worker binding metadata.');
        }
        // Never project plaintext, JSON vars, credentials or D1 identifiers.
        return { name: binding.name, type: binding.type };
      });
      unique(bindings.map((x) => x.name), 'Worker bindings');
      const secrets = (await get(prefix + '/secrets')).result;
      assertRecords(secrets, 'Worker Secret list');
      const secretNames = unique(secrets.map((item) => {
        if (typeof item.name !== 'string' || !SECRET_NAME.test(item.name)) {
          throw new Error('Invalid Worker Secret name.');
        }
        return item.name;
      }), 'Worker Secret name');
      const schedules = (await get(prefix + '/schedules')).result?.schedules;
      assertRecords(schedules, 'Worker Cron');
      const cron = unique(schedules.map((item) => {
        if (typeof item.cron !== 'string') throw new Error('Invalid Worker Cron.');
        return item.cron;
      }), 'Worker Cron');
      const subdomain = (await get(prefix + '/subdomain')).result;
      if (typeof subdomain?.enabled !== 'boolean' || typeof subdomain?.previews_enabled !== 'boolean') {
        throw new Error('Invalid Worker public subdomain metadata.');
      }
      // Keep raw D1 ID / Service destination in scope only for comparisons.
      const d1 = settings.bindings.find((x) => x.type === 'd1' && x.name === 'TOKEN_STATS_DB');
      const serviceTargets = settings.bindings
        .filter((x) => x.type === 'service')
        .map((x) => ({ name: x.name, service: x.service }));
      return {
        bindings,
        secretNames,
        cron,
        workersDev: subdomain.enabled,
        previewsEnabled: subdomain.previews_enabled,
        d1: d1?.database_id || d1?.id || null,
        serviceTargets,
      };
    },
  };
}

export async function inspectProductionWorkers(client) {
  const present = new Set(await client.scripts());
  const observed = {};
  for (const name of WORKERS) {
    observed[name] = present.has(name) ? await client.worker(name) : null;
  }
  const issues = [];
  const inventory = {};
  for (const name of WORKERS) {
    const w = observed[name];
    if (!w) {
      inventory[name] = { deployed: false };
      issues.push('WORKER_NOT_DEPLOYED:' + name);
      continue;
    }
    const retired = unique([...w.secretNames, ...w.bindings.map((x) => x.name)].filter((n) => RETIRED.test(n)), 'retired names');
    if (retired.length) issues.push('RETIRED_BINDINGS_PRESENT:' + name);
    if (name === 'ai-gateway' && w.secretNames.some((n) => NODE_CREDENTIAL.test(n))) {
      issues.push('GATEWAY_PROVIDER_CREDENTIALS_PRESENT');
    }
    if (name !== 'ai-gateway' && (w.workersDev || w.previewsEnabled)) {
      issues.push('PRIVATE_WORKER_EXPOSED:' + name);
    }
    inventory[name] = {
      deployed: true,
      bindings: w.bindings,
      secret_names: w.secretNames,
      crons: w.cron,
      workers_dev: w.workersDev,
      previews_enabled: w.previewsEnabled,
      retired_binding_count: retired.length,
    };
  }
  const gateway = observed['ai-gateway'];
  const inference = observed['ai-inference-center'];
  const generation = observed['ai-generation-center'];
  const operations = observed['ai-gateway-operations'];
  const services = gateway?.serviceTargets || [];
  for (const [binding, service] of [
    ['AIG_INFERENCE_SERVICE', 'ai-inference-center'],
    ['AIG_GENERATION_SERVICE', 'ai-generation-center'],
  ]) {
    if (!services.some((x) => x.name === binding && x.service === service)) {
      issues.push('GATEWAY_SERVICE_BINDING_MISMATCH:' + binding);
    }
  }
  if (gateway && !gateway.bindings.some((x) => x.name === 'TIER1_AFFINITY' && x.type === 'kv_namespace')) {
    issues.push('GATEWAY_TIER1_KV_MISSING');
  }
  if (gateway && operations && (!gateway.d1 || gateway.d1 !== operations.d1)) {
    issues.push('SHARED_D1_MISMATCH');
  }
  const gatewayCron = gateway?.cron;
  const operationsCron = operations?.cron;
  let cronPhase = 'incomplete';
  if (gatewayCron && operationsCron) {
    if (JSON.stringify(gatewayCron) === JSON.stringify([MAINTENANCE]) && operationsCron.length === 0) cronPhase = 'prepare';
    else if (gatewayCron.length === 0 && operationsCron.length === 0) cronPhase = 'detach';
    else if (gatewayCron.length === 0 && JSON.stringify(operationsCron) === JSON.stringify([MAINTENANCE])) cronPhase = 'activate';
    else {
      cronPhase = 'unsafe';
      issues.push('CRON_OWNERSHIP_UNSAFE');
    }
  }
  return {
    workers: inventory,
    cron_phase: cronPhase,
    metadata_consistency: issues.length === 0 ? 'pass' : 'blocked',
    blockers: issues,
    unverified: ['provider-token-values', 'runtime-health', 'event-propagation', 'rollback', 'route-exposure'],
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
    // Contains metadata and Secret NAMES, never Secret values; do not overwrite.
    fs.writeFileSync(argv[1], JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const summary = {
    inspected_worker_count: Object.values(report.workers).filter((x) => x.deployed).length,
    cron_phase: report.cron_phase,
    metadata_consistency: report.metadata_consistency,
    blockers: report.blockers,
    unverified: report.unverified,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
  if (report.metadata_consistency !== 'pass') process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Cloudflare inventory refused; inspect protected credentials or API permissions. No changes made.');
    process.exitCode = 2;
  });
}
