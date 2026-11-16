#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HTTP_STATUS = /(?:^|[^\d])(429|502|503|504)(?!\d)/;
const CLOUDFLARE_1102 = /(?:^|[^\d])1102(?!\d)/;

export function summarizeSessionJsonl(text) {
  const failures = {};
  const statuses = {};
  const steps = new Set();
  let retries = 0;
  let cloudflare1102 = 0;
  let retryDelayMs = 0;
  let firstRetryAtMs = null;
  let lastRetryAtMs = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'llm/retry') continue;
    retries++;
    const data = event.data ?? {};
    const failure = data.failure ?? {};
    const code = typeof failure.code === 'string' ? failure.code : 'UNKNOWN';
    failures[code] = (failures[code] ?? 0) + 1;
    const message = typeof failure.message === 'string' ? failure.message : '';
    const status = HTTP_STATUS.exec(message)?.[1];
    if (status) statuses[status] = (statuses[status] ?? 0) + 1;
    if (CLOUDFLARE_1102.test(message)) cloudflare1102++;
    const delay = data.delayMs;
    if (typeof delay === 'number' && Number.isFinite(delay) && delay > 0) retryDelayMs += delay;
    if (data.turn !== undefined && data.step !== undefined) steps.add(String(data.turn) + ':' + String(data.step));
    if (typeof event.time === 'number' && Number.isFinite(event.time)) {
      firstRetryAtMs = firstRetryAtMs === null ? event.time : Math.min(firstRetryAtMs, event.time);
      lastRetryAtMs = lastRetryAtMs === null ? event.time : Math.max(lastRetryAtMs, event.time);
    }
  }
  return { retries, retriedSteps: steps.size, failures, statuses, cloudflare1102, retryDelayMs, firstRetryAtMs, lastRetryAtMs };
}

export function summarizeSessionFiles(files) {
  const perFile = files.map((file) => summarizeSessionJsonl(file));
  const totals = {
    retries: 0,
    retriedSteps: 0,
    failures: {},
    statuses: {},
    cloudflare1102: 0,
    retryDelayMs: 0,
    firstRetryAtMs: null,
    lastRetryAtMs: null,
  };
  for (const part of perFile) {
    totals.retries += part.retries;
    totals.retriedSteps += part.retriedSteps;
    totals.cloudflare1102 += part.cloudflare1102;
    totals.retryDelayMs += part.retryDelayMs;
    for (const [key, value] of Object.entries(part.failures)) totals.failures[key] = (totals.failures[key] ?? 0) + value;
    for (const [key, value] of Object.entries(part.statuses)) totals.statuses[key] = (totals.statuses[key] ?? 0) + value;
    if (part.firstRetryAtMs !== null)
      totals.firstRetryAtMs = totals.firstRetryAtMs === null ? part.firstRetryAtMs : Math.min(totals.firstRetryAtMs, part.firstRetryAtMs);
    if (part.lastRetryAtMs !== null)
      totals.lastRetryAtMs = totals.lastRetryAtMs === null ? part.lastRetryAtMs : Math.max(totals.lastRetryAtMs, part.lastRetryAtMs);
  }
  return totals;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    console.error('Usage: node scripts/session-retry-report.mjs <extracted-session.jsonl> [...]');
    process.exitCode = 64;
  } else {
    const report = summarizeSessionFiles(paths.map((path) => readFileSync(path, 'utf8')));
    console.log(JSON.stringify(report, null, 2));
  }
}
