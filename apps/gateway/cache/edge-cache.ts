// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import { readEnv } from '../../../src/config/env.ts';
import { getLimits } from '../../../src/config/timeouts.ts';
import { getLogger } from '../../../src/observability/logger.ts';
import { corsHeaders } from '../../../src/protocol/http.ts';
import { SYNTHETIC_CLIENT_STREAM_HEADER } from '../../../src/stream/client-lifecycle.ts';
import { SseLifecycleObserver, type SseProtocol } from '../../../src/stream/sse-lifecycle.ts';
import { presentedCredentials } from '../policy/auth.ts';

function defaultCache(): Cache | null {
  if (typeof caches === 'undefined') return null;
  return (caches as unknown as { default?: Cache }).default ?? null;
}

const ELIGIBLE_ROUTES = new Set(['openai_chat', 'openai_responses', 'anthropic_messages']);

const MAX_CACHED_BYTES = 256 * 1024;
const MAX_CACHEABLE_REQUEST_CHARS = 256 * 1024;

export function edgeCacheEligible(route: string, request: Request): boolean {
  if (!ELIGIBLE_ROUTES.has(route)) return false;
  const header = request.headers.get('x-gateway-cache');
  return header?.trim().toLowerCase() === 'true';
}

export async function callerCacheScope(request: Request, env: GatewayEnv): Promise<string | null> {
  const hmacKey = readEnv(env, 'AIG_EDGE_CACHE_HMAC_KEY');
  if (!hmacKey || hmacKey.length < 32) return null;
  const credentials = presentedCredentials(request).sort();
  if (credentials.length === 0) return '';
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(`aig-edge-cache-v1:${hmacKey}`);
  const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(credentials.join('\0'))));
  return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

export async function buildEdgeCacheKeyRequest(
  route: string,
  requestedModel: string,
  bodyJson: Record<string, unknown>,
  keyGroup: string,
  options: { stream?: boolean; scope?: string; host: string },
): Promise<Request> {
  const { stream, stream_options, ...restBody } = bodyJson;
  const isStreamRequested = options.stream ?? stream === true;
  const canonical = JSON.stringify(
    sortKeys({
      v: 3,
      route,
      model: requestedModel,
      group: keyGroup,
      scope: options.scope ?? '',
      stream: isStreamRequested,
      stream_options: isStreamRequested ? (stream_options ?? null) : null,
      body: restBody,
    }),
  );
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  const url = `https://${options.host}/__gateway_cache/v3/${encodeURIComponent(route)}/${hashHex}`;
  return new Request(url, { method: 'GET' });
}

export async function matchEdgeCache(keyRequest: Request, request: Request, env: GatewayEnv): Promise<Response | null> {
  const cache = defaultCache();
  if (!cache) return null;
  let cached: Response | undefined;
  try {
    cached = await cache.match(keyRequest);
  } catch {
    return null;
  }
  if (!cached) return null;
  const headers = new Headers(cached.headers);
  headers.set('x-gateway-cache-status', 'HIT');
  headers.set('cache-control', 'private, no-store');
  for (const [k, v] of Object.entries(corsHeaders(request, env))) {
    headers.set(k, v);
  }
  if (/text\/event-stream/i.test(cached.headers.get('content-type') || '')) {
    headers.set(SYNTHETIC_CLIENT_STREAM_HEADER, '1');
  }
  return new Response(cached.body, { status: 200, headers });
}

export type EdgeCachePlan = {
  keyRequest: Request;
  ttlSec: number;
  stream: boolean;
  route: string;
};

let hasLoggedMissingCacheHmacKey = false;

function logEdgeCacheDisabledOnce(env: GatewayEnv): void {
  if (hasLoggedMissingCacheHmacKey) return;
  hasLoggedMissingCacheHmacKey = true;
  getLogger(env).debug('[edge-cache] disabled: AIG_EDGE_CACHE_HMAC_KEY is absent or shorter than 32 characters (cache replay disabled).');
}

export async function resolveEdgeCachePlan(
  route: string,
  requestedModel: string,
  bodyJson: Record<string, unknown>,
  request: Request,
  env: GatewayEnv,
  keyGroup: string,
  isStreamRequested: boolean,
  bodyChars?: number,
): Promise<EdgeCachePlan | null> {
  if (!edgeCacheEligible(route, request)) return null;
  if (typeof bodyChars === 'number' && bodyChars > MAX_CACHEABLE_REQUEST_CHARS) return null;
  const ttl = getLimits(env).edgeCacheTtlSec;
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  const scope = await callerCacheScope(request, env);
  if (scope === null) {
    logEdgeCacheDisabledOnce(env);
    return null;
  }
  const host = new URL(request.url).host;
  const keyRequest = await buildEdgeCacheKeyRequest(route, requestedModel, bodyJson, keyGroup, { stream: isStreamRequested, scope, host });
  return { keyRequest, ttlSec: ttl, stream: isStreamRequested, route };
}

async function readCachedResponseBytes(
  response: Response,
  maxBytes: number,
  protocol?: SseProtocol,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  if (signal?.aborted) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const observer = protocol ? new SseLifecycleObserver(protocol, { strictDataValidation: true }) : null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => {
    reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return null;
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
      total += value.byteLength;
      observer?.pushBytes(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  observer?.finishBytes();
  if (
    observer &&
    (observer.terminal !== 'success' ||
      observer.unsafeToolUse ||
      observer.incompleteResponse ||
      observer.observationTruncated ||
      observer.malformedEvent ||
      observer.bytesAfterTerminal)
  )
    return null;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function jsonResponseIsCacheSafe(bytes: Uint8Array): boolean {
  try {
    const root = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (!root || typeof root !== 'object' || root.error != null) return false;
    const visit = (value: unknown, key = ''): boolean => {
      if (/^(?:tool_calls|function_call|tool_use|computer_call)$/i.test(key)) return true;
      if (!value || typeof value !== 'object') return false;
      if (Array.isArray(value)) return value.some((item) => visit(item));
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (
          /^(?:finish_reason|stop_reason)$/i.test(childKey) &&
          /^(?:tool_calls|function_call|tool_use|max_tokens|length|content_filter)$/i.test(String(childValue))
        )
          return true;
        if (/^status$/i.test(childKey) && /^(?:failed|incomplete)$/i.test(String(childValue))) return true;
        if (/^type$/i.test(childKey) && /^(?:function_call|tool_use|computer_call)$/i.test(String(childValue))) return true;
        if (visit(childValue, childKey)) return true;
      }
      return false;
    };
    return !visit(root);
  } catch {
    return false;
  }
}

function protocolForRoute(route: string): SseProtocol | undefined {
  if (route === 'openai_chat') return 'openai_chat';
  if (route === 'openai_responses') return 'openai_responses';
  if (route === 'anthropic_messages') return 'anthropic';
  return undefined;
}

export function storeEdgeCacheResponse(
  ctx: { waitUntil?: (p: Promise<unknown>) => void } | undefined,
  keyRequest: Request,
  response: Response,
  ttlSec: number,
  isStreamExpected: boolean,
  routeHint?: string,
  signal?: AbortSignal,
): void {
  const cache = defaultCache();
  if (!cache) return;
  if (response.status !== 200 || !response.body) return;
  const ct = response.headers.get('content-type') || '';
  const isStream = /text\/event-stream/i.test(ct);
  if (isStream !== isStreamExpected || (!isStream && !/json/i.test(ct))) return;
  const buffering = response.headers.get('x-accel-buffering');
  const task = (async () => {
    const keyPath = new URL(keyRequest.url).pathname.split('/').filter(Boolean);
    const route = routeHint || decodeURIComponent(keyPath.at(-2) || '');
    const bytes = await readCachedResponseBytes(response, MAX_CACHED_BYTES, isStream ? protocolForRoute(route) : undefined, signal);
    if (bytes === null || (!isStream && !jsonResponseIsCacheSafe(bytes))) return;
    if (signal?.aborted) return;
    const headers = new Headers({ 'content-type': ct });
    if (buffering) headers.set('x-accel-buffering', buffering);
    headers.set('cache-control', `public, max-age=${Math.max(1, Math.trunc(ttlSec))}`);
    const cacheBody = bytes.buffer as ArrayBuffer;
    await cache.put(keyRequest, new Response(cacheBody, { status: 200, headers }));
  })().catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(task);
}

export function injectMissHeader(response: Response, request: Request, env: GatewayEnv): Response {
  const headers = new Headers(response.headers);
  headers.set('x-gateway-cache-status', 'MISS');
  headers.set('cache-control', 'private, no-store');
  for (const [k, v] of Object.entries(corsHeaders(request, env))) {
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
}
