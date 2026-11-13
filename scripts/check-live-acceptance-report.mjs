#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Entirely offline: no Gateway, Provider, D1 or credential access.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAcceptanceReport, parseCheckEvidence, parseFailureEvidence, validExpectedSha } from './live-acceptance-report-core.mjs';

const expectedSha = 'a'.repeat(40);
assert.equal(validExpectedSha(expectedSha), true);
assert.equal(validExpectedSha('a'.repeat(7)), false);
assert.equal(validExpectedSha('not-a-commit'), false);

const evidence = parseCheckEvidence(JSON.stringify({
  result: 'PASS',
  check: 'perception-delegate',
  status: 200,
  duration_ms: 123,
  request_id: 'safe-request-01',
  attempts: '2',
  dispatches: '2',
  gateway_code: null,
  failover: 'true',
  authorization: 'never-keep-this',
  content: 'never-keep-raw-reply',
}));
assert.equal(evidence.check, 'perception-delegate');
assert.equal(evidence.dispatches, 2);
assert.equal(evidence.failover, true);
assert.equal(evidence.request_id, 'safe-request-01');
assert.equal(JSON.stringify(evidence).includes('never-keep'), false);
assert.equal(parseCheckEvidence('not-json'), null);
assert.equal(parseCheckEvidence(JSON.stringify({ result: 'PASS', check: 'bad check', authorization: 'private' })), null);
assert.equal(parseCheckEvidence(JSON.stringify({ result: 'FAIL', check: 'text' })), null);

const error = parseFailureEvidence(
  JSON.stringify({ result: 'FAIL', message: 'text: HTTP 429, gateway_code=rate_limit; extra response should not be saved' }),
);
assert.deepEqual(error, { stage: 'request', category: 'http_error', check: 'text', http_status: 429, gateway_code: 'rate_limit' });
assert.equal(JSON.stringify(error).includes('extra response'), false);
const unknownFailure = parseFailureEvidence(JSON.stringify({ result: 'FAIL', message: 'upstream returned a private response' }));
assert.equal(unknownFailure.category, 'assertion_or_transport');
assert.equal(unknownFailure.check, null);

const baseReport = {
  origin: 'https://gateway.example',
  expectedSha,
  readiness: { build: expectedSha, status: 'ready', ready: true, degraded: false, httpStatus: 200 },
  startedAt: '2026-11-13T00:00:00.000Z',
  completedAt: '2026-11-13T00:01:00.000Z',
  checks: [evidence],
  exitCode: 0,
  failure: null,
  plannedImageCalls: 0,
};
const passed = createAcceptanceReport(baseReport);
assert.equal(passed.result, 'PASS');
assert.equal(passed.version.verified, true);
assert.equal(passed.summary.passed, 1);
assert.equal(passed.summary.actual_billed_image_calls, null);
assert.equal(JSON.stringify(passed).includes('never-keep'), false);

const mismatch = createAcceptanceReport({ ...baseReport, readiness: { ...baseReport.readiness, build: 'b'.repeat(40) } });
assert.equal(mismatch.result, 'FAIL');
assert.equal(mismatch.version.verified, false);
const missingVersion = createAcceptanceReport({ ...baseReport, readiness: { ...baseReport.readiness, build: 'unknown' } });
assert.equal(missingVersion.result, 'FAIL');
const noReady = createAcceptanceReport({ ...baseReport, readiness: { ...baseReport.readiness, ready: false } });
assert.equal(noReady.result, 'FAIL');
const failed = createAcceptanceReport({ ...baseReport, exitCode: 1, failure: error });
assert.equal(failed.result, 'FAIL');
assert.equal(failed.failure.http_status, 429);

const runner = fileURLToPath(new URL('./run-live-acceptance-report.mjs', import.meta.url));
const usage = execFileSync(process.execPath, [runner, '--help'], { encoding: 'utf8' });
assert.match(usage, /--report-file/);
assert.match(usage, /--expected-sha/);
console.log('Live acceptance report evidence contracts passed offline.');
