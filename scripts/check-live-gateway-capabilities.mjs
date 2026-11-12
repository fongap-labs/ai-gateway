#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Real public Gateway smoke checks. No Provider simulation, no deployment,
// and no stored credentials. Only --run-image authorizes a billable image call.

const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--run-image' || arg === '--run-direct-image' || arg === '--run-auto-image') {
    options[arg.slice(2)] = true;
    continue;
  }
  if (!arg?.startsWith('--') || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    throw new Error(`Missing value for ${arg || '<argument>'}`);
  }
  options[arg.slice(2)] = process.argv[++index];
}
if (!options.url || !options['chat-model']) {
  throw new Error(
    'Usage: node scripts/check-live-gateway-capabilities.mjs --url https://gateway.example --chat-model Max [--vision-model Omni] [--delegate-model Code-Max] [--run-image --image-model Image-Creator] [--run-direct-image] [--failover-model Code-Max --expect-dispatches 2]',
  );
}
const base = new URL(options.url);
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('--url must be an HTTPS origin with no credentials, path, query or fragment.');
}
if (options['run-direct-image'] && !options['run-image']) throw new Error('--run-direct-image requires --run-image.');
if (options['run-auto-image'] && !options['run-image']) throw new Error('--run-auto-image requires --run-image.');
if (options['run-image'] && !options['image-model']) throw new Error('--run-image requires --image-model.');
if (options['expect-dispatches'] && !options['failover-model']) throw new Error('--expect-dispatches requires --failover-model.');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGN8JiLCwMDAxMDAwMDAAAANpAESe7q5qgAAAABJRU5ErkJggg==';
const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } };
const results = [];

function keyFor(group) {
  const name = `AIG_ACCESS_KEY_${group}`;
  const key = process.env[name];
  if (!key) throw new Error(`${name} is required for a requested live check (the secret will not be logged).`);
  return key;
}

async function checkedRequest(label, key, route, body, assertion, timeoutMs = 90_000) {
  const started = Date.now();
  const response = await fetch(new URL(route, base), {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Never log raw replies: image responses contain potentially sensitive data.
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error(`${label}: invalid response JSON (status ${response.status})`);
  }
  const summary = {
    check: label,
    status: response.status,
    duration_ms: Date.now() - started,
    request_id: response.headers.get('x-request-id'),
    attempts: response.headers.get('x-gateway-attempts'),
    dispatches: response.headers.get('x-gateway-dispatches'),
    gateway_code: response.headers.get('x-gateway-error-code') ?? json?.error?.details?.gateway_code ?? null,
  };
  results.push(summary);
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}, gateway_code=${summary.gateway_code ?? 'unknown'}`);
  assertion(json, response);
  console.log(JSON.stringify({ ...summary, result: 'PASS' }));
  return summary;
}
const chat = (model, text) => ({ model, messages: [{ role: 'user', content: text }], stream: false });
const maxGroup = String(options['text-key-group'] || 'MAX').toUpperCase();
const visionGroup = String(options['vision-key-group'] || maxGroup).toUpperCase();
const textKey = keyFor(maxGroup);
try {
  await checkedRequest('text', textKey, '/v1/chat/completions', chat(options['chat-model'], 'Reply exactly: ok'), (reply) => {
    if (typeof reply?.choices?.[0]?.message?.content !== 'string') throw new Error('Text call did not return Chat completion text.');
  });

  if (options['vision-model']) {
    const visionKey = keyFor(visionGroup);
    await checkedRequest(
      'omni-direct',
      visionKey,
      '/v1/chat/completions',
      { model: options['vision-model'], messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe the attached image.' }, image] }] },
      (reply) => {
        if (!reply?.choices?.[0]?.message?.content) throw new Error('Direct vision returned no observations.');
      },
    );
  }
  if (options['delegate-model']) {
    const visionKey = keyFor(visionGroup);
    await checkedRequest(
      'perception-delegate',
      visionKey,
      '/v1/chat/completions',
      { model: options['delegate-model'], messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe the attached image.' }, image] }] },
      (reply) => {
        if (!reply?.choices?.[0]?.message?.content) throw new Error('Vision delegate returned no observations.');
      },
    );
  }
  if (options['failover-model']) {
    const summary = await checkedRequest(
      'failover',
      textKey,
      '/v1/chat/completions',
      chat(options['failover-model'], 'Reply exactly: ok'),
      (reply) => {
        if (!reply?.choices?.[0]?.message?.content) throw new Error('Failover check returned no text.');
      },
    );
    if (options['expect-dispatches']) {
      const count = Number(summary.dispatches);
      if (!summary.dispatches || !Number.isInteger(count) || count < Number(options['expect-dispatches'])) {
        throw new Error('Failover could not be verified: enable dispatch evidence and use a controlled staging pool with a failing first node.');
      }
    }
  }
  if (options['run-image']) {
    const agentKey = keyFor('AGENT');
    const toolBody = {
      model: options['chat-model'],
      messages: [{ role: 'user', content: 'Draw one small square.' }],
      tools: [{ type: 'function', function: { name: 'generate_image', parameters: { type: 'object', properties: {} } } }],
      tool_choice: { type: 'function', function: { name: 'generate_image' } },
      metadata: { aig_image_model: options['image-model'], aig_image_size: '1024x1024' },
      stream: false,
    };
    await checkedRequest(
      'chat-image-tool',
      agentKey,
      '/v1/chat/completions',
      toolBody,
      (reply, response) => {
        if (response.headers.get('x-gateway-image-tool') !== 'true') throw new Error('Chat request never entered image tool.');
        if (!String(reply?.choices?.[0]?.message?.content || '').startsWith('![Generated image](data:image/png;base64,')) {
          throw new Error('Chat image tool returned no image data.');
        }
      },
      150_000,
    );
    if (options['run-auto-image']) {
      await checkedRequest(
        'chat-auto-image-tool',
        agentKey,
        '/v1/chat/completions',
        { ...toolBody, tool_choice: 'auto' },
        (reply, response) => {
          if (response.headers.get('x-gateway-image-tool') !== 'true') {
            throw new Error('Auto tool selection never executed Generation Center; verify the staging model supports function tools.');
          }
          if (!String(reply?.choices?.[0]?.message?.content || '').startsWith('![Generated image](data:image/')) {
            throw new Error('Automatic Chat image tool returned no image data.');
          }
        },
        150_000,
      );
    }
    if (options['run-direct-image']) {
      await checkedRequest(
        'generation-direct',
        agentKey,
        '/v1/images/generations',
        { model: options['image-model'], prompt: 'Draw one small square.', size: '1024x1024', n: 1, response_format: 'b64_json' },
        (reply) => {
          if (typeof reply?.data?.[0]?.b64_json !== 'string') throw new Error('Direct Generation Center returned no image data.');
        },
        150_000,
      );
    }
  }
  console.log(
    JSON.stringify({
      result: 'PASS',
      checks: results.length,
      billable_image_calls: options['run-image'] ? 1 + Number(!!options['run-direct-image']) + Number(!!options['run-auto-image']) : 0,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({ result: 'FAIL', message: error instanceof Error ? error.message : String(error), checks_completed: results.length }),
  );
  process.exitCode = 1;
}
