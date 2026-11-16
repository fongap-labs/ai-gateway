#!/usr/bin/env node
import assert from 'node:assert/strict';
import { summarizeSessionFiles, summarizeSessionJsonl } from './session-retry-report.mjs';

const event = (time, turn, step, code, message, delayMs) =>
  JSON.stringify({
    type: 'llm/retry',
    time,
    data: { turn, step, delayMs, failure: { code, message } },
  });
const one = [
  JSON.stringify({ type: 'session', data: { private: 'not-exported' } }),
  event(100, 1, 1, 'SERVER', '503 | Code-Max unavailable', 500),
  event(200, 1, 1, 'TRANSPORT', 'Connection error; Cloudflare Error 1102', 1500),
  event(300, 1, 2, 'RATE_LIMIT', '429: retry after 10s', 0),
  'invalid-json-line',
].join('\n');
const two = [event(400, 1, 1, 'TIMEOUT', '504: upstream timed out', 200), event(500, 2, 1, 'TRANSPORT', '502: upstream closed', 300)].join('\n');
assert.deepEqual(summarizeSessionJsonl(one), {
  retries: 3,
  retriedSteps: 2,
  failures: { SERVER: 1, TRANSPORT: 1, RATE_LIMIT: 1 },
  statuses: { 503: 1, 429: 1 },
  cloudflare1102: 1,
  retryDelayMs: 2000,
  firstRetryAtMs: 100,
  lastRetryAtMs: 300,
});
assert.deepEqual(summarizeSessionFiles([one, two]), {
  retries: 5,
  retriedSteps: 4,
  failures: { SERVER: 1, TRANSPORT: 2, RATE_LIMIT: 1, TIMEOUT: 1 },
  statuses: { 429: 1, 502: 1, 503: 1, 504: 1 },
  cloudflare1102: 1,
  retryDelayMs: 2500,
  firstRetryAtMs: 100,
  lastRetryAtMs: 500,
});
assert.equal(summarizeSessionFiles([]).retries, 0);
console.log('DSH free-Worker failure-summary regression passed; no raw session data emitted.');
