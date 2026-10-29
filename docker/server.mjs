// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Node.js host for the Worker fetch handler, used by the Docker image. It adapts
// node:http to the Web Fetch API and calls the same `fetch(request, env, ctx)`
// that Cloudflare Workers runs. Workers-only bindings (D1, KV, Cache API, cron)
// are absent here, and every consumer of them already fails open.

import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import worker from '../src/index.ts';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';

const ctx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch((error) => {
      console.error('background task failed:', error?.message || error);
    });
  },
};

function toRequest(req, signal) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  const init = { method: req.method, headers, signal };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function writeResponse(res, response) {
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  res.statusCode = response.status;

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  const closed = once(res, 'close');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await Promise.race([once(res, 'drain'), closed]);
      }
      if (res.destroyed) {
        // Client went away: cancel the upstream body so cancellation propagates.
        await reader.cancel().catch(() => {});
        return;
      }
    }
    res.end();
  } catch (error) {
    console.error('response stream failed:', error?.message || error);
    res.destroy(error);
  }
}

const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  let response;
  try {
    response = await worker.fetch(toRequest(req, controller.signal), process.env, ctx);
  } catch (error) {
    console.error('unhandled gateway error:', error?.message || error);
    response = Response.json({ error: 'internal_error' }, { status: 500 });
  }
  await writeResponse(res, response);
});

server.listen(port, host, () => {
  console.log(`ai-gateway listening on ${host}:${port}`);
});

function shutdown(signal) {
  console.log(`received ${signal}, draining connections`);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
