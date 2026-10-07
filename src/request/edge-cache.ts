// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Edge idempotent cache for inference requests that opt in with
// x-gateway-cache: true, or that send temperature=0 when AIG_EDGE_CACHE_AUTO
// is enabled. Uses the Cloudflare Cache API at the edge colo. A HIT replays the exact client-facing
// response with zero upstream consumption; a MISS continues the normal
// pipeline and stores the successful response non-blocking via waitUntil.

import { getBool, readEnv } from '../config/env.ts';
import { corsHeaders } from '../protocol/http.ts';
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
const MAX_CACHED_CHARS = 2 * 1024 * 1024;
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
 * never replays another key's cached answers. The HMAC key is derived from AIG_TOKEN_ENCRYPTION_KEY
 * when it is configured; the fingerprint is never logged or returned.
 */
export async function callerCacheScope(request: Request, env: GatewayEnv): Promise<string> {
  const credentials = presentedCredentials(request).sort();
  if (credentials.length === 0) return '';
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(`aig-edge-cache-v1:${readEnv(env, 'AIG_TOKEN_ENCRYPTION_KEY') ?? ''}`);
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
  const wantsStream = options.stream ?? stream === true;
  const canonical = JSON.stringify(
    sortKeys({
      v: 3,
      route,
      model: requestedModel,
      group: keyGroup,
      scope: options.scope ?? '',
      stream: wantsStream,
      stream_options: wantsStream ? (stream_options ?? null) : null,
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
  wantsStream: boolean,
): Promise<EdgeCachePlan | null> {
  if (!edgeCacheEligible(route, bodyJson, request, env)) return null;
  const ttlSec = readEnv(env, 'AIG_EDGE_CACHE_TTL_SEC');
  const ttl = ttlSec ? Number(ttlSec) : 14400;
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  const scope = await callerCacheScope(request, env);
  const keyRequest = await buildEdgeCacheKeyRequest(route, requestedModel, bodyJson, keyGroup, { stream: wantsStream, scope });
  return { keyRequest, ttlSec: ttl, stream: wantsStream };
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
  expectStream: boolean,
): void {
  const cache = defaultCache();
  if (!cache) return;
  if (response.status !== 200 || !response.body) return;
  // The response must have the shape the key promised: a stream for a streaming client, JSON otherwise.
  const ct = response.headers.get('content-type') || '';
  const isStream = /text\/event-stream/i.test(ct);
  if (isStream !== expectStream || (!isStream && !/json/i.test(ct))) return;
  const buffering = response.headers.get('x-accel-buffering');
  const task = (async () => {
    const text = await response.text();
    if (text.length > MAX_CACHED_CHARS || NON_CACHEABLE_MARKER.test(text)) return;
    if (isStream && !STREAM_END_MARKER.test(text)) return;
    // Build the stored response with TTL and baked HIT marker
    const headers = new Headers({ 'content-type': ct });
    if (buffering) headers.set('x-accel-buffering', buffering);
    headers.set('cache-control', `public, max-age=${ttlSec}`);
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
