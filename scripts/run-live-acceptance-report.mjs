#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Run the existing real-HTTP checks only after verifying the public build SHA.
// Write one exclusive, local evidence file. No credentials or replies are saved.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAcceptanceReport, parseCheckEvidence, parseFailureEvidence, validExpectedSha } from './live-acceptance-report-core.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/run-live-acceptance-report.mjs --report-file ./acceptance.json --expected-sha FULL_40_CHAR_SHA --url https://gateway.example --chat-model Max [other check-live-gateway-capabilities.mjs options]');
  process.exit(0);
}

let reportFile = null;
let expectedSha = null;
let origin = null;
const forwarded = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--report-file' || arg === '--expected-sha') {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing report path or expected build SHA.');
    if (arg === '--report-file') reportFile = value;
    else expectedSha = value;
    continue;
  }
  if (arg === '--url') origin = args[index + 1];
  forwarded.push(arg);
}

if (!reportFile || !validExpectedSha(expectedSha)) throw new Error('A new --report-file and full 40-character --expected-sha are required.');
if (!origin) throw new Error('Missing --url for the live Gateway.');
const base = new URL(origin);
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('--url must be an HTTPS origin with no credentials, path, query or fragment.');
}
if (!forwarded.includes('--chat-model')) throw new Error('--chat-model is required for the live check.');
const plannedImageCalls = forwarded.includes('--run-image')
  ? 1 + Number(forwarded.includes('--run-direct-image')) + Number(forwarded.includes('--run-auto-image'))
  : 0;

const startedAt = new Date().toISOString();
let readiness = null;
let exitCode = 1;
let failure = null;
let checks = [];
try {
  let response;
  try {
    response = await fetch(new URL('/health/ready', base), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    failure = { stage: 'readiness', category: 'network_error', check: null };
    throw new Error('Readiness network check failed.');
  }
  let body;
  try {
    body = await response.json();
  } catch {
    failure = { stage: 'readiness', category: 'invalid_json', check: null };
    throw new Error('Readiness response was not JSON.');
  }
  readiness = {
    build: body?.build,
    ready: body?.ready,
    degraded: body?.degraded,
    status: body?.status,
    httpStatus: response.status,
  };
  if (!response.ok || body?.ready !== true || body?.degraded !== false) {
    failure = { stage: 'readiness', category: 'not_ready', check: null };
    throw new Error('Gateway is not ready for live acceptance.');
  }
  if (body.build !== expectedSha) {
    failure = { stage: 'readiness', category: 'build_mismatch', check: null };
    throw new Error('Gateway build differs from the approved expected SHA.');
  }

  const runner = fileURLToPath(new URL('./check-live-gateway-capabilities.mjs', import.meta.url));
  const child = spawn(process.execPath, [runner, ...forwarded], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const maxOutputChars = 64_000;
  let exceeded = false;
  const append = (which, data) => {
    const value = which === 'out' ? stdout : stderr;
    if (value.length + data.length > maxOutputChars) {
      exceeded = true;
      child.kill();
      return;
    }
    if (which === 'out') stdout += data;
    else stderr += data;
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => append('out', data));
  child.stderr.on('data', (data) => append('err', data));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  checks = stdout.split('\n').map(parseCheckEvidence).filter(Boolean);
  const failedChecks = stderr.split('\n').map(parseFailureEvidence).filter(Boolean);
  if (exceeded) failure = { stage: 'request', category: 'output_limit', check: null };
  else if (code !== 0) failure = failedChecks.at(-1) ?? { stage: 'request', category: 'nonzero_exit', check: null };
  exitCode = failure ? 1 : 0;
} catch {
  failure ??= { stage: 'request', category: 'execution_error', check: null };
}

const report = createAcceptanceReport({
  origin: base.origin,
  expectedSha,
  readiness,
  startedAt,
  completedAt: new Date().toISOString(),
  checks,
  exitCode,
  failure,
  plannedImageCalls,
});
try {
  // Exclusively create a private file rather than overwriting past evidence.
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} catch {
  console.error(JSON.stringify({ result: 'FAIL', category: 'report_write_failed' }));
  process.exitCode = 1;
}
console.log(JSON.stringify({ result: report.result, checks_passed: report.summary.passed, version_verified: report.version.verified }));
if (report.result !== 'PASS') process.exitCode = 1;
