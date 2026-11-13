#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Opt-in live acceptance. Requires a real Gateway and an access key; never runs in CI.
// Validates the selected logical model/route, not every configured physical node.
import assert from 'node:assert/strict';

const opts = {};
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  if (['--responses', '--tools', '--stream'].includes(name)) { opts[name.slice(2)] = true; continue; }
  if (!name?.startsWith('--') || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw Error('Expected value for ' + name);
  opts[name.slice(2)] = process.argv[++i];
}
if (!opts.url || !opts.model) throw Error('Usage: node scripts/check-live-code-contract.mjs --url https://gateway.example --model Code-Max [--key-group MAX] [--tools] [--responses] [--stream]');
const base = new URL(opts.url);
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error('URL must be a bare HTTPS origin');
const keyName = 'AIG_ACCESS_KEY_' + String(opts['key-group'] || 'MAX').toUpperCase();
const key = process.env[keyName];
if (!key) throw Error('Missing ' + keyName + ' environment variable (secret never logged)');
const messages = [{ role: 'user', content: 'Reply exactly ok.' }];
const tools = [{ type: 'function', function: { name: 'diagnostic_noop', description: 'Safe no-op diagnostic tool; do not execute', parameters: { type: 'object', properties: {}, additionalProperties: false } } }];
const trials = [
  { name: 'chat_text', route: '/v1/chat/completions', body: { model: opts.model, stream: false, messages } },
];
if (opts.tools) trials.push({ name: 'chat_tools', route: '/v1/chat/completions', body: { model: opts.model, stream: false, messages, tools, tool_choice: 'auto' } });
if (opts.responses) trials.push({ name: 'responses_text', route: '/v1/responses', body: { model: opts.model, stream: false, input: 'Reply exactly ok.' } });
if (opts.stream) trials.push({ name: 'chat_stream', route: '/v1/chat/completions', body: { model: opts.model, stream: true, messages }, stream: true });
if (opts.stream && opts.responses) trials.push({ name: 'responses_stream', route: '/v1/responses', body: { model: opts.model, stream: true, input: 'Reply exactly ok.' }, stream: true });

async function check(trial) {
  const started = Date.now();
  const response = await fetch(new URL(trial.route, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(trial.body),
    signal: AbortSignal.timeout(90_000),
  });
  const summary = {
    probe: trial.name, model: opts.model, http_status: response.status,
    request_id: response.headers.get('x-request-id'),
    node: response.headers.get('x-gateway-node') ?? null,
    attempts: response.headers.get('x-gateway-attempts') ?? null,
    duration_ms: Date.now() - started,
  };
  if (!response.ok) {
    let error = null;
    try { error = (await response.json())?.error; } catch { /* no trusted JSON */ }
    console.log(JSON.stringify({ ...summary, result: 'FAIL', error_code: error?.code ?? error?.details?.gateway_code ?? null, error_param: error?.param ?? null }));
    throw Error(trial.name + ': upstream returned HTTP ' + response.status);
  }
  if (!trial.stream) {
    const value = await response.json();
    if (trial.route.endsWith('/responses')) assert.ok(Array.isArray(value?.output) && value.status !== 'failed', 'Invalid Responses result');
    else assert.ok(value?.choices?.[0]?.message && typeof value.choices[0].message === 'object', 'Invalid Chat completion');
  } else {
    if (!response.body) throw Error(trial.name + ': no SSE body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let bytes = 0;
    let hasFinish = false, hasDone = false, completed = false, interrupted = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 512 * 1024) throw Error('SSE exceeded diagnostic memory bound');
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (!data) continue;
          if (data === '[DONE]') { hasDone = true; continue; }
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event.error || event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') interrupted = true;
          if (trial.route.endsWith('/responses')) completed ||= event.type === 'response.completed';
          else hasFinish ||= event.choices?.some(choice => choice?.finish_reason !== undefined && choice.finish_reason !== null) ?? false;
        }
      }
    } finally { reader.releaseLock(); }
    if (interrupted || !(trial.route.endsWith('/responses') ? completed : hasFinish && hasDone)) {
      throw Error(trial.name + ': incomplete SSE terminal event (finish_reason + [DONE] or response.completed missing)');
    }
  }
  console.log(JSON.stringify({ ...summary, result: 'PASS' }));
}
let completed = 0;
try {
  for (const trial of trials) { await check(trial); completed++; }
  console.log(JSON.stringify({ result: 'PASS', checks: completed, scope: 'logical-route-only', warning: 'Not per-node capability certification' }));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', checks_completed: completed, message: String(error?.message ?? error) }));
  process.exitCode = 1;
}
