// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Edge idempotent cache for inference requests that opt in with
// x-gateway-cache: true, or that send temperature=0 when AIG_EDGE_CACHE_AUTO
// is enabled. Uses the Cloudflare Cache API at the edge colo. A HIT replays the exact client-facing
// response with zero upstream consumption; a MISS continues the normal
// pipeline and stores the successful response non-blocking via waitUntil.
//
// Fail-closed: the cache key's credential fingerprint is an HMAC keyed from
// AIG_TOKEN_ENCRYPTION_KEY. When that secret is not configured, callerCacheScope()
// returns null and the edge cache is disabled entirely (no lookup, no store),
// even for requests that opt in. This matches the token store's no-key policy.

import { getBool, readEnv } from '../config/env.ts';
import { getLimits } from '../config/timeouts.ts';
import { getLogger } from '../observability/logger.ts';
import { corsHeaders } from '../protocol/http.ts';
import { SYNTHETIC_CLIENT_STREAM_HEADER } from '../stream/client-lifecycle.ts';
import type { GatewayEnv } from '../types/runtime.ts';
import { presentedCredentials } from './auth.ts';

const EDGE_CACHE_HOST = 'edge-cache.ai-gateway.internal';

// The Cloudflare Cache API default cache. Typed defensively because the
// `caches` global may be absent (dev harness) or untyped in some runtimes.
function defaultCache(): Cache | null {
  if (typeof caches === 'undefined') return null;
  return (caches as unknown as { default?: Cache }).default ?? null;
}

// Inference routes eligible for edge caching.
const ELIGIBLE_ROUTES = new Set(['openai_chat', 'openai_responses', 'anthropic_messages']);

// A response that asks the client to run a tool is never replayed, and a body this large is not
// worth a cache slot.
const NON_CACHEABLE_MARKER = /"(?:tool_calls|function_call|tool_use)"/;
const MAX_CACHED_BYTES = 2 * 1024 * 1024;
// Canonicalising and hashing a large request body costs another full copy.
// Large prompts are not useful cache candidates, so skip them before sortKeys.
const MAX_CACHEABLE_REQUEST_CHARS = 256 * 1024;
// A streamed response is only stored when the stream ended normally.
const STREAM_END_MARKER = /\[DONE\]|"message_stop"|response\.completed/;

/**
 * Determines whether a request is eligible for edge cache lookup.
 * Eligible if: (1) route is an inference route, and (2) the caller sent
 * x-gateway-cache: true, or temperature === 0 while AIG_EDGE_CACHE_AUTO is on.
 * Automatic caching is off by default: a replayed answer is visible to every holder of the key.
 */
export function edgeCacheEligible(route: string, bodyJson: Record<string, unknown>, request: Request, env: GatewayEnv = {}): boolean {
  if (!ELIGIBLE_ROUTES.has(route)) return false;
  const header = request.headers.get('x-gateway-cache');
  if (header && header.trim().toLowerCase() === 'true') return true;
  return getBool(env, 'AIG_EDGE_CACHE_AUTO', false) && bodyJson?.temperature === 0;
}

/**
 * Non-reversible fingerprint of the credential the caller presented, so rotating or replacing a key
 * never replays another key's cached answers. The HMAC key is derived from AIG_TOKEN_ENCRYPTION_KEY;
 * the fingerprint is never logged or returned. Returns null (fail-closed) when that secret is not
 * configured, because a fingerprint derived from a public constant would be forgeable.
 */
export async function callerCacheScope(request: Request, env: GatewayEnv): Promise<string | null> {
  const encryptionKey = readEnv(env, 'AIG_TOKEN_ENCRYPTION_KEY');
  if (!encryptionKey) return null;
  const credentials = presentedCredentials(request).sort();
  if (credentials.length === 0) return '';
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(`aig-edge-cache-v1:${encryptionKey}`);
  const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(credentials.join('\0'))));
  return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sorts object keys recursively so semantically identical JSON hashes the
 * same. Arrays keep their order (positional semantics). The result is
 * serialized with JSON.stringify, which keeps types and string boundaries
 * distinct ("1" vs 1, "" vs null, a value containing "," or ":").
 */
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

/**
 * Builds the virtual cache-key Request for the Cloudflare Cache API.
 * The key incorporates the key schema version, route, model, the caller's
 * access-key group and credential fingerprint, whether the client wants a
 * stream, and a SHA-256 of the canonical request body. A streamed and a
 * non-streamed answer are different responses, so they never share an entry.
 */
export async function buildEdgeCacheKeyRequest(
  route: string,
  requestedModel: string,
  bodyJson: Record<string, unknown>,
  keyGroup: string,
  options: { stream?: boolean; scope?: string } = {},
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
  const url = `https://${EDGE_CACHE_HOST}/${route}/${hashHex}`;
  return new Request(url, { method: 'GET' });
}

/**
 * Attempts a cache lookup. Returns a HIT response with x-gateway-cache-status: HIT
 * and CORS headers, or null on MISS / error.
 */
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
  // Clone headers, inject HIT marker and CORS
  const headers = new Headers(cached.headers);
  headers.set('x-gateway-cache-status', 'HIT');
  for (const [k, v] of Object.entries(corsHeaders(request, env))) {
    headers.set(k, v);
  }
  // A replayed stream is not an upstream stream, so trackClientResponse would otherwise
  // never finalize it. The marker makes it wrap the stream and count the outcome (success
  // on completion, cancellation on client abort) and decrement activeRequests.
  if (/text\/event-stream/i.test(cached.headers.get('content-type') || '')) {
    headers.set(SYNTHETIC_CLIENT_STREAM_HEADER, '1');
  }
  return new Response(cached.body, { status: 200, headers });
}

/**
 * Plan produced by the preflight stage when caching is eligible.
 * Carried through the request pipeline to the success handler.
 */
export type EdgeCachePlan = {
  keyRequest: Request;
  ttlSec: number;
  stream: boolean;
};

// Logged once per isolate: an operator who opted in but left the key unset
// should see why the cache stays off, without a line per request.
let hasLoggedMissingEncryptionKey = false;

function logEdgeCacheDisabledOnce(env: GatewayEnv): void {
  if (hasLoggedMissingEncryptionKey) return;
  hasLoggedMissingEncryptionKey = true;
  getLogger(env).debug('[edge-cache] disabled: AIG_TOKEN_ENCRYPTION_KEY is not configured (fail-closed; the cache key needs it).');
}

/**
 * Computes the edge cache plan (key + TTL) if eligible, else null.
 * Intended to be called from preflight after validation/model-authz.
 */
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
  if (!edgeCacheEligible(route, bodyJson, request, env)) return null;
  if (typeof bodyChars === 'number' && bodyChars > MAX_CACHEABLE_REQUEST_CHARS) return null;
  const ttlSec = readEnv(env, 'AIG_EDGE_CACHE_TTL_SEC');
  // An explicit AIG_EDGE_CACHE_TTL_SEC wins; the DEFAULT is limits-owned
  // (AIG_COST_GUARDS switches it from the 4h prompt cache to off entirely —
  // edge PUTs are their own storage-IO cost).
  const ttl = ttlSec ? Number(ttlSec) : getLimits(env).edgeCacheTtlDefaultSec;
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  const scope = await callerCacheScope(request, env);
  if (scope === null) {
    logEdgeCacheDisabledOnce(env);
    return null;
  }
  const keyRequest = await buildEdgeCacheKeyRequest(route, requestedModel, bodyJson, keyGroup, { stream: isStreamRequested, scope });
  return { keyRequest, ttlSec: ttl, stream: isStreamRequested };
}

/**
 * Reads at most maxBytes without materialising an unbounded response. Returns
 * null when the body is too large or the stream fails.
 */
async function readCachedResponseText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return null;
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * Stores a successful response in the edge cache non-blocking.
 * The caller MUST pass a clone (the client-facing response) because
 * Cache.put() reads the body fully and the original response must
 * remain readable for the client.
 *
 * The stored response carries a baked-in x-gateway-cache-status: HIT
 * so a future matchEdgeCache call returns it with the marker already set.
 */
export function storeEdgeCacheResponse(
  ctx: { waitUntil?: (p: Promise<unknown>) => void } | undefined,
  keyRequest: Request,
  response: Response,
  ttlSec: number,
  isStreamExpected: boolean,
): void {
  const cache = defaultCache();
  if (!cache) return;
  if (response.status !== 200 || !response.body) return;
  // The response must have the shape the key promised: a stream for a streaming client, JSON otherwise.
  const ct = response.headers.get('content-type') || '';
  const isStream = /text\/event-stream/i.test(ct);
  if (isStream !== isStreamExpected || (!isStream && !/json/i.test(ct))) return;
  const buffering = response.headers.get('x-accel-buffering');
  const task = (async () => {
    const text = await readCachedResponseText(response, MAX_CACHED_BYTES);
    if (text === null || NON_CACHEABLE_MARKER.test(text)) return;
    if (isStream && !STREAM_END_MARKER.test(text)) return;
    // Build the stored response with TTL and baked HIT marker
    const headers = new Headers({ 'content-type': ct });
    if (buffering) headers.set('x-accel-buffering', buffering);
    headers.set('cache-control', `private, no-store`);
    headers.set('x-gateway-cache-status', 'HIT');
    await cache.put(keyRequest, new Response(text, { status: 200, headers }));
  })().catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(task);
}

/**
 * Injects a MISS marker into a client response for cache-eligible requests
 * that reached the upstream. Rebuilds the response to set the header
 * without disturbing the body.
 */
export function injectMissHeader(response: Response, request: Request, env: GatewayEnv): Response {
  const headers = new Headers(response.headers);
  headers.set('x-gateway-cache-status', 'MISS');
  for (const [k, v] of Object.entries(corsHeaders(request, env))) {
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
}
