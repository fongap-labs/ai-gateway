#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Operations Cron handoff: read-only by default. Activation/reversal require
// explicit operator approval, an offline four-Worker plan, and live CF checks.
// Never print credentials, response bodies, account identifiers or D1 IDs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseTopology } from './check-private-center-release.mjs';

export const MAINTENANCE_CRON = '0 3 * * *';
const GATEWAY = 'ai-gateway';
const OPERATIONS = 'ai-gateway-operations';
const SHA = /^[a-f0-9]{40}$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validSchedules(schedules) {
  return Array.isArray(schedules) && new Set(schedules).size === schedules.length && schedules.every((cron) => typeof cron === 'string');
}

export function classifyCronOwnership(snapshot) {
  const { gateway, operations } = snapshot;
  if (!validSchedules(gateway) || !validSchedules(operations)) throw new Error('Invalid remote Cron schedules.');
  if (same(gateway, [MAINTENANCE_CRON]) && same(operations, [])) return 'prepare';
  if (same(gateway, []) && same(operations, [])) return 'detach';
  if (same(gateway, []) && same(operations, [MAINTENANCE_CRON])) return 'activate';
  throw new Error('Unexpected or overlapping remote Cron schedules; manual review required.');
}

export function createCloudflareCronClient({ accountId, token, fetchImpl = fetch }) {
  if (!ACCOUNT_ID.test(accountId || '') || typeof token !== 'string' || token.length < 16) {
    throw new Error('Cloudflare read-only Cron inventory credentials are not configured.');
  }
  async function call(worker, method, schedules) {
    if (worker !== GATEWAY && worker !== OPERATIONS) throw new Error('Unknown Worker in Cron control.');
    if (method === 'PUT' && (worker !== OPERATIONS || ![[], [MAINTENANCE_CRON]].some((v) => same(v, schedules)))) {
      throw new Error('Cron control may change only the approved Operations schedule.');
    }
    const url = ['https://api.cloudflare.com/client/v4/accounts', accountId, 'workers/scripts', worker, 'schedules'].join('/');
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'PUT' ? { body: JSON.stringify(schedules.map((cron) => ({ cron }))) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    if (!response?.ok) throw new Error('Cloudflare Cron schedule read or update failed; inspect the protected runner.');
    const body = await response.json().catch(() => null);
    const entries = body?.result?.schedules;
    if (body?.success !== true || !Array.isArray(entries) || !entries.every((entry) => entry && typeof entry.cron === 'string')) {
      throw new Error('Cloudflare Cron schedule response was invalid.');
    }
    const values = entries.map((entry) => entry.cron);
    if (!validSchedules(values)) throw new Error('Cloudflare returned duplicate or invalid Cron schedules.');
    return values;
  }
  return {
    read: (worker) => call(worker, 'GET'),
    writeOperations: (schedules) => call(OPERATIONS, 'PUT', schedules),
  };
}

export async function readCronSnapshot(client) {
  // Deliberately re-read both Worker schedules around each mutation.
  return { gateway: await client.read(GATEWAY), operations: await client.read(OPERATIONS) };
}

export async function activateOperationsCron(client) {
  const before = classifyCronOwnership(await readCronSnapshot(client));
  if (before === 'activate') return 'already-active';
  if (before !== 'detach') throw new Error('Gateway Cron must be detached remotely before Operations activation.');
  let attempted = false;
  try {
    attempted = true;
    await client.writeOperations([MAINTENANCE_CRON]);
    const after = classifyCronOwnership(await readCronSnapshot(client));
    if (after !== 'activate') throw new Error('Operations Cron activation could not be confirmed.');
    return 'activated';
  } catch {
    // A timed-out PUT could still have changed Cloudflare state. Best-effort
    // disable Operations and require human intervention if postflight failed.
    if (attempted) {
      try {
        await client.writeOperations([]);
      } catch {
        // Never claim ownership is safe after failed reversal.
      }
    }
    throw new Error('Operations Cron activation failed; verify both live schedules before retry or rollback.');
  }
}

export async function deactivateOperationsCron(client) {
  const before = await readCronSnapshot(client);
  if (!validSchedules(before.gateway) || !validSchedules(before.operations)) throw new Error('Invalid live Cron inventory.');
  if (![[], [MAINTENANCE_CRON]].some((value) => same(value, before.gateway))) {
    throw new Error('Gateway has an unexpected Cron; refusing to change another Worker.');
  }
  if (![[], [MAINTENANCE_CRON]].some((value) => same(value, before.operations))) {
    throw new Error('Operations has an unexpected Cron; refusing to modify unrecognized schedules.');
  }
  if (before.operations.length === 0) return 'already-disabled';
  // Emergency reversal also works when both Workers are active, so an operator
  // can immediately remove a duplicate Operations Cron owner.
  await client.writeOperations([]);
  const after = await readCronSnapshot(client);
  if (after.operations.length !== 0 || ![[], [MAINTENANCE_CRON]].some((value) => same(value, after.gateway))) {
    throw new Error('Operations Cron deactivation could not be confirmed; manual intervention required.');
  }
  return 'disabled';
}

function assertApprovedPlan(file, action, env) {
  if (env.AIG_OPERATIONS_CRON_APPROVED !== action || !SHA.test(env.DEPLOY_SOURCE_SHA || '')) {
    throw new Error('Explicit protected cutover approval and immutable source SHA are required.');
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
    assertReleaseTopology(plan);
  } catch {
    throw new Error('Offline four-Worker topology plan is invalid.');
  }
  if (plan.source_sha !== env.DEPLOY_SOURCE_SHA || plan.stage !== (action === 'activate' ? 'activate' : 'detach')) {
    throw new Error('Approved source SHA or Cron handoff phase differs from the release plan.');
  }
}

async function main(argv, env) {
  if (argv.length !== 1 && !(argv.length === 3 && argv[1] === '--plan')) {
    throw new Error('usage: operations-cron-control.mjs inspect | activate --plan FILE | deactivate --plan FILE');
  }
  const action = argv[0];
  if (!['inspect', 'activate', 'deactivate'].includes(action) || (action === 'inspect' && argv.length !== 1)) {
    throw new Error('Invalid Cron control action.');
  }
  if (action !== 'inspect') assertApprovedPlan(argv[2], action, env);
  const client = createCloudflareCronClient({ accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN });
  const result =
    action === 'inspect'
      ? classifyCronOwnership(await readCronSnapshot(client))
      : action === 'activate'
        ? await activateOperationsCron(client)
        : await deactivateOperationsCron(client);
  console.log('Operations Cron control passed: ' + result + '.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch(() => {
    console.error('Operations Cron control refused. Recheck protected approval, topology and live schedules.');
    process.exitCode = 2;
  });
}
