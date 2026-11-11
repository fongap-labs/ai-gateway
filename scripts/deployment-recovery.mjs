#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Read-only Cloudflare deployment identity ledger for fail-closed Gateway recovery.
// Cloudflare API Token reads deployment identity; no secret values are stored.
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRemote } from './github-deployment-config.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{40}$/;
const accountPattern = /^[a-f0-9]{32}$/i;
const worker = 'ai-gateway';
const schemaVersion = 1;

function sameIdentity(a, b) {
  return a.deployment_id === b.deployment_id && a.version_id === b.version_id;
}

export function parseActiveDeployment(body) {
  const deployments = body?.result?.deployments;
  if (body?.success !== true || !Array.isArray(deployments) || deployments.length === 0) {
    throw new Error('Cloudflare active Worker deployment is unavailable.');
  }
  // Cloudflare specifies the first entry as the deployment serving traffic.
  const deployment = deployments[0];
  const versions = deployment?.versions;
  if (
    !uuid.test(deployment?.id ?? '') ||
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0]?.percentage !== 100 ||
    !uuid.test(versions[0]?.version_id ?? '')
  ) {
    throw new Error('Production must have exactly one verified 100% Worker version.');
  }
  const message = deployment.annotations?.['workers/message'];
  return {
    deployment_id: deployment.id.toLowerCase(),
    version_id: versions[0].version_id.toLowerCase(),
    message: typeof message === 'string' ? message : null,
  };
}

export function establishRecoveryBaseline(before, after, build, accountId) {
  if (!accountPattern.test(accountId ?? '') || !sameIdentity(before, after) || !sha.test(build ?? '')) {
    throw new Error('Healthy baseline identity changed or the build SHA is unverified.');
  }
  return {
    schema_version: schemaVersion,
    account_id: accountId.toLowerCase(),
    worker,
    previous: {
      deployment_id: before.deployment_id,
      version_id: before.version_id,
      build,
    },
    published: null,
  };
}

export function recordPublishedDeployment(snapshot, active, sourceSha) {
  if (
    !validSnapshot(snapshot) ||
    snapshot.published !== null ||
    !sha.test(sourceSha ?? '') ||
    sameIdentity(snapshot.previous, active) ||
    active.version_id === snapshot.previous.version_id ||
    active.message !== `action-worker:deploy:${sourceSha}`
  ) {
    throw new Error('New deployment ownership and immutable source SHA are not verified.');
  }
  return {
    ...snapshot,
    published: {
      deployment_id: active.deployment_id,
      version_id: active.version_id,
      build: sourceSha,
    },
  };
}

export function confirmPublishedIdentity(snapshot, active) {
  if (
    !validSnapshot(snapshot) ||
    snapshot.published === null ||
    !sameIdentity(snapshot.published, active) ||
    active.message !== `action-worker:deploy:${snapshot.published.build}`
  ) {
    throw new Error('Production drifted before the deployment success audit.');
  }
}

export function guardedRollbackTarget(snapshot, active) {
  confirmPublishedIdentity(snapshot, active);
  return snapshot.previous.version_id;
}

export function confirmRestoredIdentity(snapshot, first, second, build) {
  if (
    !validSnapshot(snapshot) ||
    snapshot.published === null ||
    !sameIdentity(first, second) ||
    first.version_id !== snapshot.previous.version_id ||
    first.deployment_id === snapshot.published.deployment_id ||
    build !== snapshot.previous.build
  ) {
    throw new Error('Cloudflare rollback and restored health are not proven.');
  }
}

function validSnapshot(snapshot) {
  return (
    snapshot?.schema_version === schemaVersion &&
    snapshot?.worker === worker &&
    accountPattern.test(snapshot.account_id ?? '') &&
    uuid.test(snapshot.previous?.deployment_id ?? '') &&
    uuid.test(snapshot.previous?.version_id ?? '') &&
    sha.test(snapshot.previous?.build ?? '') &&
    (snapshot.published === null ||
      (uuid.test(snapshot.published?.deployment_id ?? '') &&
        uuid.test(snapshot.published?.version_id ?? '') &&
        sha.test(snapshot.published?.build ?? '')))
  );
}

export async function fetchActiveDeployment(accountId, token, request = fetch) {
  if (!accountPattern.test(accountId ?? '') || typeof token !== 'string' || !token.trim()) {
    throw new Error('Protected Cloudflare Worker account and token are required.');
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/deployments?per_page=1&page=1`;
  const response = await request(url, {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Cloudflare Worker deployment inventory is unreadable.');
  const body = await response.json().catch(() => null);
  return parseActiveDeployment(body);
}

function readSnapshot(file, accountId) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('Recovery evidence file permissions are unsafe.');
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!validSnapshot(data) || data.account_id !== accountId.toLowerCase()) {
    throw new Error('Recovery evidence belongs to another account or is invalid.');
  }
  return data;
}

function saveSnapshot(file, data, exclusive) {
  const destination = exclusive ? file : `${file}.next`;
  writeFileSync(destination, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  if (!exclusive) renameSync(destination, file);
}

async function main() {
  const [operation, filename] = process.argv.slice(2);
  if (
    !['snapshot', 'capture-published', 'verify-published', 'rollback-target', 'verify-restored'].includes(operation) ||
    !filename ||
    process.argv.length !== 4
  ) {
    throw new Error('Unsupported Gateway recovery command.');
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const token = process.env.CLOUDFLARE_API_TOKEN ?? '';
  const publicUrl = process.env.AIG_PUBLIC_URL ?? '';
  if (!accountPattern.test(accountId) || !token.trim() || !publicUrl.trim()) {
    throw new Error('Gateway recovery preflight is missing protected configuration.');
  }
  const active = () => fetchActiveDeployment(accountId, token);
  const healthyBuild = async (expected) =>
    await verifyRemote(publicUrl, expected, {
      allowDegraded: String(process.env.AIG_ALLOW_DEGRADED ?? '').toLowerCase() === 'true',
    });

  if (operation === 'snapshot') {
    const before = await active();
    const build = await healthyBuild(undefined);
    const after = await active();
    const snapshot = establishRecoveryBaseline(before, after, build, accountId);
    saveSnapshot(filename, snapshot, true);
    console.log('Previous healthy Gateway deployment and immutable version recorded.');
    return;
  }

  const snapshot = readSnapshot(filename, accountId);
  if (operation === 'capture-published') {
    const sourceSha = process.env.DEPLOY_SOURCE_SHA ?? '';
    saveSnapshot(filename, recordPublishedDeployment(snapshot, await active(), sourceSha), false);
    console.log('Published Gateway version and source identity verified.');
  } else if (operation === 'verify-published') {
    confirmPublishedIdentity(snapshot, await active());
    console.log('Gateway production deployment identity confirmed after health checks.');
  } else if (operation === 'rollback-target') {
    // Print only the validated, pre-publish immutable Cloudflare version ID.
    console.log(guardedRollbackTarget(snapshot, await active()));
  } else {
    const before = await active();
    if (before.version_id !== snapshot.previous.version_id) {
      throw new Error('Rollback did not restore the recorded Worker version.');
    }
    const restoredBuild = await healthyBuild(snapshot.previous.build);
    const after = await active();
    confirmRestoredIdentity(snapshot, before, after, restoredBuild);
    console.log('Previous Gateway version and its public health are independently verified.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Gateway recovery guard: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 77;
  });
}
