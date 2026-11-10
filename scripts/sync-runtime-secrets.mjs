#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// One protected GitHub Environment (ai-gateway-ops) supplies all runtime authentication.
// The same center key is written to its private Worker and the Gateway binding.
// Provider shards are deliberately not moved, deleted or read by this operation.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const centers = [
  ['ai-inference-center', 'AIG_INFERENCE_AUTH_KEY'],
  ['ai-perception-center', 'AIG_PERCEPTION_AUTH_KEY'],
  ['ai-generation-center', 'AIG_GENERATION_AUTH_KEY'],
];
const secretPattern = /^[A-Za-z0-9_-]{32,}$/;
const accountPattern = /^[0-9a-f]{32}$/;

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Protected ai-gateway-ops Secret is unavailable: ${name}`);
  return value;
}

export function buildRuntimeSecretPlan(env) {
  const account = required(env, 'CLOUDFLARE_ACCOUNT_ID');
  const token = required(env, 'CLOUDFLARE_API_TOKEN');
  if (!accountPattern.test(account)) throw new Error('Approved Cloudflare account ID is invalid.');
  const health = required(env, 'AIG_DEPLOY_HEALTH_KEY');
  if (!secretPattern.test(health) || Buffer.byteLength(health, 'utf8') > 4500) {
    throw new Error('AIG_DEPLOY_HEALTH_KEY requires 32 or more URL-safe characters within the Cloudflare Secret size limit.');
  }
  const values = centers.map(([worker, name]) => {
    const value = required(env, name);
    if (value.length < 32 || Buffer.byteLength(value, 'utf8') > 4500) {
      throw new Error(`Protected center authentication Secret is invalid: ${name}`);
    }
    return { worker, name, value };
  });
  if (new Set([health, ...values.map((v) => v.value)]).size !== 4) {
    throw new Error('Deployment health and three center authentication keys must be distinct.');
  }
  // All four Workers use a single Cloudflare account, one audited source and no separate ops environments.
  return {
    account,
    token,
    workers: ['ai-gateway', ...centers.map(([worker]) => worker)],
    writes: [
      ...values.map(({ worker, name, value }) => ({ worker, name, value })),
      ...values.map(({ name, value }) => ({ worker: 'ai-gateway', name, value })),
      { worker: 'ai-gateway', name: 'AIG_DEPLOY_HEALTH_KEY', value: health },
    ],
  };
}

function endpoint(account, worker) {
  return `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/secrets`;
}

async function request(fetcher, url, token, method, body) {
  let response;
  try {
    response = await fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('Cloudflare Secret API is unavailable; runtime state has not been verified.');
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Cloudflare Secret API returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok || !data || data.success !== true) {
    throw new Error(`Cloudflare Secret API refused ${method} (HTTP ${response.status}); no alternate account or token is used.`);
  }
  return data.result;
}

async function inventory(fetcher, account, token, worker) {
  const data = await request(fetcher, endpoint(account, worker), token, 'GET');
  if (!Array.isArray(data)) throw new Error(`Invalid Secret inventory for ${worker}.`);
  const names = new Set();
  for (const entry of data) {
    if (!entry || typeof entry.name !== 'string' || entry.type !== 'secret_text' || names.has(entry.name)) {
      throw new Error(`Invalid or duplicate Cloudflare Secret metadata for ${worker}.`);
    }
    names.add(entry.name);
  }
  return names;
}

export async function synchronizeRuntimeSecrets(env, fetcher = fetch) {
  const plan = buildRuntimeSecretPlan(env);
  // Fail before ANY mutation if a Worker is missing or the token cannot inspect it.
  for (const worker of plan.workers) await inventory(fetcher, plan.account, plan.token, worker);
  for (const { worker, name, value } of plan.writes) {
    const result = await request(fetcher, endpoint(plan.account, worker), plan.token, 'PUT', {
      name,
      text: value,
      type: 'secret_text',
    });
    if (!result || result.name !== name || result.type !== 'secret_text') {
      throw new Error(`Cloudflare did not confirm the ${worker} / ${name} update; review the partial change before retry.`);
    }
  }
  // Cloudflare cannot return secret values; verify each expected name after the writes.
  for (const worker of plan.workers) {
    const names = await inventory(fetcher, plan.account, plan.token, worker);
    const missing = plan.writes.filter((item) => item.worker === worker && !names.has(item.name));
    if (missing.length) throw new Error(`Cloudflare did not retain ${worker} Secret metadata: ${missing.map((item) => item.name).join(', ')}.`);
  }
  return { workers: plan.workers.length, bindings: plan.writes.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    if (command === 'preflight') {
      const plan = buildRuntimeSecretPlan(process.env);
      console.log(
        `Protected runtime authentication preflight passed: ${plan.workers.length} Workers / ${plan.writes.length} bindings; values not logged.`,
      );
    } else if (command === 'reconcile') {
      const result = await synchronizeRuntimeSecrets(process.env);
      console.log(`Cloudflare runtime authentication synchronized: ${result.workers} Workers / ${result.bindings} bindings; values not logged.`);
    } else {
      throw new Error('usage: sync-runtime-secrets.mjs <preflight|reconcile>');
    }
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : 'runtime Secret synchronization failed'}`);
    process.exitCode = 1;
  }
}
