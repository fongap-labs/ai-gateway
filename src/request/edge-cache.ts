// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Edge idempotent cache for deterministic (temperature=0) or explicitly
// opted-in (x-gateway-cache: true) inference requests. Uses the Cloudflare
// Cache API at the edge colo. A HIT replays the exact client-facing
// response with zero upstream consumption; a MISS continues the normal
// pipeline and stores the successful response non-blocking via waitUntil.

import { readEnv } from '../config/env.ts';
import { corsHeaders } from '../protocol/http.ts';
import type { GatewayEnv } from '../types/runtime.ts';

const EDGE_CACHE_HOST = 'edge-cache.ai-gateway.internal';

// The Cloudflare Cache API default cache. Typed defensively because the
// `caches` global may be absent (dev harness) or untyped in some runtimes.
function defaultCache(): Cache | null {
  if (typeof caches === 'undefined') return null;
  return (caches as unknown as { default?: Cache }).default ?? null;
}

// Inference routes eligible for edge caching.
const ELIGIBLE_ROUTES = new Set(['openai_chat', 'openai_responses', 'anthropic_messages']);

// Fields that affect wire format but NOT response content — excluded from
// the cache key so equivalent logical requests share a cache entry.
const _KEY_EXCLUDED_FIELDS = new Set(['stream', 'stream_options']);

/**
 * Determines whether a request is eligible for edge cache lookup.
 * Eligible if: (1) route is an inference route, (2) temperature === 0
 * or x-gateway-cache: true header present.
 */
export function edgeCacheEligible(route: string, bodyJson: Record<string, unknown>, request: Request): boolean {
  if (!ELIGIBLE_ROUTES.has(route)) return false;
  const header = request.headers.get('x-gateway-cache');
  if (header && header.trim().toLowerCase() === 'true') return true;
  return bodyJson?.temperature === 0;
}

/**
 * Canonicalizes a value for deterministic hashing. Sorts object keys
 * recursively to make the hash order-independent for semantically
 * identical JSON. Arrays keep their order (positional semantics).
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  // Object: sort keys and recurse
  const entries = Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${canonicalize(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Builds the virtual cache-key Request for the Cloudflare Cache API.
 * The key incorporates route, model, and a SHA-256 of the canonical
 * request body (minus wire-format fields).
 */
export async function buildEdgeCacheKeyRequest(route: string, requestedModel: string, bodyJson: Record<string, unknown>): Promise<Request> {
  // Build the cache key material: route + model + canonical body (minus excluded fields)
  const { stream, stream_options, ...restBody } = bodyJson;
  const bodyForKey = { route, model: requestedModel, ...restBody };
  const canonical = canonicalize(bodyForKey);
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
): Promise<EdgeCachePlan | null> {
  if (!edgeCacheEligible(route, bodyJson, request)) return null;
  const ttlSec = readEnv(env, 'AIG_EDGE_CACHE_TTL_SEC');
  const ttl = ttlSec ? Number(ttlSec) : 14400;
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  const keyRequest = await buildEdgeCacheKeyRequest(route, requestedModel, bodyJson);
  return { keyRequest, ttlSec: ttl };
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
): void {
  const cache = defaultCache();
  if (!cache) return;
  if (response.status !== 200 || !response.body) return;
  // Build the stored response with TTL and baked HIT marker
  const headers = new Headers();
  const ct = response.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  const buffering = response.headers.get('x-accel-buffering');
  if (buffering) headers.set('x-accel-buffering', buffering);
  headers.set('cache-control', `public, max-age=${ttlSec}`);
  headers.set('x-gateway-cache-status', 'HIT');
  let stored: Response;
  try {
    stored = new Response(response.body, { status: 200, headers });
  } catch {
    return;
  }
  const task = cache.put(keyRequest, stored).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(task);
  else task.catch(() => {});
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
