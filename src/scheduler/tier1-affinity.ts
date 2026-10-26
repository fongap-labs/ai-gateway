// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Tier 1 session affinity is a soft score bias. The deployed Worker has no
// session-sticky routing, so the binding is stored in KV and only cached
// briefly in isolate memory. Tier 2/3 never read or write this store.
//
// Memory safety: both the affinity cache and the escape counters use a
// bounded TTL map. A client that floods unique session ids can never
// grow isolate memory unboundedly — expired entries are evicted first, then
// the oldest entries by insertion order (LRU-ish). The raw client Session ID
// is never stored as a Map key; a stable synchronous hash is used instead so
// no plaintext session ID lingers in isolate memory beyond the request scope.

import { getLimits } from '../config/timeouts.ts';
import type { ExecutionContextLike, GatewayEnv } from '../types/runtime.ts';

const AIG_AFFINITY_KV_FACTOR = 0.85;
const KV_BINDING = 'TIER1_AFFINITY';
const KEY_PREFIX = 'affinity:v1:';
const TTL_SECONDS = 30 * 60;
// A cached binding is served as-is for CACHE_TTL_MS, then still served while it
// is refreshed in the background: affinity is only a score bias, so a binding
// that is a few seconds stale costs nothing, while waiting on KV costs TTFT.
const CACHE_TTL_MS = 5_000;
const CACHE_RETENTION_MS = TTL_SECONDS * 1000;
// A KV read of a cold key can take far longer than the rest of the request
// setup. Affinity is only a score bias, so a request waits at most
// AIG_AFFINITY_READ_TIMEOUT_MS for it (legacy default 50ms; AIG_HOT_PATH_GUARDS
// switches the default to 15ms); an answer that arrives later still warms the
// cache for the next request. Under AIG_HOT_PATH_GUARDS the read path is also
// guarded by an isolate-local breaker: a KV endpoint that keeps timing out
// would otherwise cost every request the same tail, so that many consecutive
// timeouts stop issuing new reads for a cooldown (cached bindings are still
// served; the binding is simply treated as unknown for cold keys).
const BREAKER_TRIP_TIMEOUTS = 5;
const BREAKER_OPEN_MS = 30_000;
const TIMED_OUT = Symbol('timed out');
const ESCAPE_CHECK_REQUESTS = 10;
const ESCAPE_CHECK_MS = 5 * 60_000;
const ESCAPE_THRESHOLD = 1.2;

// Capacity limits — internal constants, not user-facing knobs. The affinity
// cache holds recent KV lookups (5s TTL) so a few hundred entries covers a
// burst of concurrent sessions on a single isolate. The escape counter map
// tracks per-session request frequency; a few hundred is plenty for a single
// isolate's lifetime.
const CACHE_MAX_ENTRIES = 500;
const ESCAPE_MAX_ENTRIES = 500;

// Structural slice of the KV binding this module actually uses. The raw
// binding arrives as an untyped env value and is validated structurally in
// kvOf() before use.
type AffinityKV = {
  get(key: string, options?: unknown): Promise<string | null | undefined>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

// ---- Bounded TTL Map ---------------------------------------------------------
// A minimal Map wrapper with TTL + max capacity + active cleanup. Eviction
// policy: expired entries first (any position), then oldest-inserted first
// (Map preserves insertion order in JS). No precise LRU — see the task spec:
// "no need to implement complex precise LRU".
class BoundedTtlMap<V> {
  private _map: Map<string, { value: V; expiresAt: number }>;
  private _max: number;
  private _ttlMs: number;

  constructor(maxEntries: number, ttlMs: number) {
    this._map = new Map();
    this._max = maxEntries;
    this._ttlMs = ttlMs;
  }

  get(key: string): V | undefined {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this._map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this._ttlMs);
    // If the key already exists, update in place (preserves insertion order).
    if (this._map.has(key)) {
      this._map.set(key, { value, expiresAt });
      return;
    }
    // Enforce capacity: sweep expired first, then evict oldest.
    if (this._map.size >= this._max) this._evict();
    this._map.set(key, { value, expiresAt });
  }

  delete(key: string): void {
    this._map.delete(key);
  }

  clear(): void {
    this._map.clear();
  }

  get size(): number {
    return this._map.size;
  }

  private _evict(): void {
    const now = Date.now();
    // Pass 1: delete all expired entries.
    for (const [k, e] of this._map) {
      if (e.expiresAt <= now) this._map.delete(k);
    }
    // If still at capacity, evict oldest-inserted entries (Map iteration is
    // insertion order). Remove ~10% to amortize the cost across requests.
    if (this._map.size >= this._max) {
      const toRemove = Math.max(1, Math.ceil(this._max * 0.1));
      let removed = 0;
      for (const k of this._map.keys()) {
        this._map.delete(k);
        if (++removed >= toRemove) break;
      }
    }
  }
}

type CachedBinding = { accountId: string | null; freshUntil: number };
const cache = new BoundedTtlMap<CachedBinding>(CACHE_MAX_ENTRIES, CACHE_TTL_MS);
// One KV read per key at a time: concurrent requests of a session share it.
const inflightReads = new Map<string, Promise<string | null | undefined>>();
// Isolate-local breaker state for the affinity READ path (AIG_HOT_PATH_GUARDS).
let breakerOpenUntilMs = 0;
let consecutiveReadTimeouts = 0;
// Escape counters have no natural TTL — they track request frequency per
// session. Use a generous TTL (same as the escape check window) so stale
// counters for sessions that stop sending are eventually cleaned up.
const escapeCounters = new BoundedTtlMap<{ requests: number; lastCheck: number }>(ESCAPE_MAX_ENTRIES, ESCAPE_CHECK_MS);

const stats = {
  reads: 0,
  hits: 0,
  misses: 0,
  writes: 0,
  writeFailures: 0,
  selections: 0,
  selectionHits: 0,
  escapes: 0,
  timeouts: 0,
  readFailures: 0,
  staleServes: 0,
  breakerSkips: 0,
  breakerTrips: 0,
};

function kvOf(env: GatewayEnv): AffinityKV | null {
  const kv = env?.[KV_BINDING] as Partial<AffinityKV> | null | undefined;
  return kv && typeof kv.get === 'function' && typeof kv.put === 'function' ? (kv as AffinityKV) : null;
}

async function affinityKey(sessionId: string): Promise<string> {
  const bytes = new TextEncoder().encode(sessionId);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return KEY_PREFIX + hash;
}

// Synchronous non-cryptographic hash for the escape counter key. This avoids
// storing the raw client Session ID in isolate memory and does not require an
// async crypto call (shouldEvaluateAffinity is synchronous). FNV-1a 32-bit
// is sufficient — it only needs to be a stable, collision-resistant-enough
// derivation of the session ID, not a secret.
function sessionHash(sessionId: string): string {
  const str = String(sessionId);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// Claude Code does not send x-session-id; it names each conversation with
// x-claude-code-session-id, which stays the same for the whole session.
const SESSION_HEADERS = ['x-session-id', 'x-claude-code-session-id'] as const;

export function resolveTier1SessionId(request: Request): string | null {
  for (const name of SESSION_HEADERS) {
    const raw = request?.headers?.get?.(name);
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id.length >= 8 && id.length <= 128) return id;
  }
  return null;
}

function cacheBinding(key: string, accountId: string | null, now: number = Date.now()): void {
  // A known binding outlives its freshness window (served stale, refreshed in the
  // background); "no binding" is only trusted for the freshness window.
  cache.set(key, { accountId, freshUntil: now + CACHE_TTL_MS }, accountId ? CACHE_RETENTION_MS : CACHE_TTL_MS);
}

// One shared KV read per key. Resolves to the bound account, null when there is
// none, or undefined when the read failed.
function lookupBinding(kv: AffinityKV, key: string): Promise<string | null | undefined> {
  const pending = inflightReads.get(key);
  if (pending) return pending;
  stats.reads++;
  const lookup = (async () => {
    let value: string | null | undefined;
    try {
      value = await kv.get(key);
    } catch {
      // A failed read (for example the daily KV read limit) leaves the binding
      // unknown: no bias, and nothing is cached or overwritten for it.
      stats.readFailures++;
      return undefined;
    }
    const accountId = typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
    if (accountId) stats.hits++;
    else stats.misses++;
    cacheBinding(key, accountId);
    return accountId;
  })().finally(() => {
    inflightReads.delete(key);
  });
  inflightReads.set(key, lookup);
  return lookup;
}

// Resolves to the bound account, null when there is none, or undefined when the
// read failed or did not answer within AIG_AFFINITY_READ_TIMEOUT_MS (the binding
// is unknown). A binding this isolate already knows is returned at once, even
// past its freshness window; the refresh then runs in the background.
export async function readTier1Affinity(env: GatewayEnv, sessionId: string, ctx?: ExecutionContextLike): Promise<string | null | undefined> {
  if (!sessionId) return null;
  const kv = kvOf(env);
  if (!kv) return null;
  const limits = getLimits(env);
  const key = await affinityKey(sessionId);
  const cached = cache.get(key);
  if (cached !== undefined) {
    if (cached.freshUntil <= Date.now() && !inflightReads.has(key)) {
      stats.staleServes++;
      cached.freshUntil = Date.now() + CACHE_TTL_MS;
      const refresh = lookupBinding(kv, key).catch(() => undefined);
      try {
        ctx?.waitUntil?.(refresh);
      } catch {
        /* the refresh still runs; it is only not extended past the response */
      }
    }
    return cached.accountId;
  }
  // Breaker (AIG_HOT_PATH_GUARDS): while open, a cold key is treated as unknown
  // immediately instead of paying another timeout tail. Cached bindings above
  // are unaffected.
  if (limits.hotPathGuards && Date.now() < breakerOpenUntilMs) {
    stats.breakerSkips++;
    return undefined;
  }
  const lookup = lookupBinding(kv, key);
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timerId = setTimeout(() => resolve(TIMED_OUT), limits.affinityReadTimeoutMs);
  });
  try {
    const accountId = await Promise.race([lookup, timeout]);
    if (accountId !== TIMED_OUT) {
      if (limits.hotPathGuards) consecutiveReadTimeouts = 0;
      return accountId;
    }
    stats.timeouts++;
    if (limits.hotPathGuards) {
      consecutiveReadTimeouts++;
      if (consecutiveReadTimeouts >= BREAKER_TRIP_TIMEOUTS) {
        consecutiveReadTimeouts = 0;
        breakerOpenUntilMs = Date.now() + BREAKER_OPEN_MS;
        stats.breakerTrips++;
      }
    }
    return undefined;
  } finally {
    clearTimeout(timerId);
  }
}

// Called only for a cold session's first Tier 1 success or a successful
// migration. Repeated successes on the same account perform no KV write.
export function writeTier1Affinity(env: GatewayEnv, ctx: ExecutionContextLike, sessionId: string, accountId: string): boolean {
  // AIG_COST_GUARDS defaults KV affinity writes OFF (AIG_AFFINITY_WRITE; an
  // explicit set wins on both sides): it is a soft score bias whose write
  // volume competes with the Free plan's 1,000 KV writes/day. Reads follow
  // their own path — with no writes, lookups miss and affinity degrades to
  // the plain score bias without stale-binding risk.
  if (!getLimits(env).tier1AffinityWrite) return false;
  const kv = kvOf(env);
  if (!sessionId || !accountId || !kv) return false;
  const operation = (async () => {
    const key = await affinityKey(sessionId);
    await kv.put(key, accountId, { expirationTtl: TTL_SECONDS });
    cacheBinding(key, accountId);
    stats.writes++;
  })().catch(() => {
    stats.writeFailures++;
  });
  if (ctx && typeof ctx.waitUntil === 'function') {
    try {
      ctx.waitUntil(operation);
    } catch {
      operation.catch(() => {});
    }
  }
  return true;
}

export function shouldEvaluateAffinity(sessionId: string | null, now: number = Date.now()): boolean {
  if (!sessionId) return false;
  const hashedKey = sessionHash(sessionId);
  const counter = escapeCounters.get(hashedKey);
  if (!counter) {
    escapeCounters.set(hashedKey, { requests: 1, lastCheck: now }, ESCAPE_CHECK_MS);
    return false;
  }
  counter.requests++;
  if (counter.requests >= ESCAPE_CHECK_REQUESTS || now - counter.lastCheck >= ESCAPE_CHECK_MS) {
    counter.requests = 0;
    counter.lastCheck = now;
    return true;
  }
  return false;
}

export function affinityShouldEscape(affinityScore: number, winnerScore: number): boolean {
  return Number.isFinite(affinityScore) && Number.isFinite(winnerScore) && affinityScore > winnerScore * ESCAPE_THRESHOLD;
}

export function tier1AffinityFactor(accountId: string, affinityAccountId: string | null): number {
  return affinityAccountId && accountId === affinityAccountId ? AIG_AFFINITY_KV_FACTOR : 1;
}

export function recordTier1AffinityDecision({ affinityHit = false, escaped = false }: { affinityHit?: boolean; escaped?: boolean } = {}): void {
  stats.selections++;
  if (affinityHit) stats.selectionHits++;
  if (escaped) stats.escapes++;
}

export function snapshotTier1Affinity(env: GatewayEnv) {
  return {
    storage: 'kv',
    binding: KV_BINDING,
    available: Boolean(kvOf(env)),
    key_format: 'sha256',
    ttl_seconds: TTL_SECONDS,
    cache_size: cache.size,
    escape_counters_size: escapeCounters.size,
    cache_max_entries: CACHE_MAX_ENTRIES,
    escape_max_entries: ESCAPE_MAX_ENTRIES,
    ...stats,
  };
}

export function __resetTier1AffinityForTests(): void {
  cache.clear();
  inflightReads.clear();
  escapeCounters.clear();
  breakerOpenUntilMs = 0;
  consecutiveReadTimeouts = 0;
  Object.assign(stats, {
    reads: 0,
    hits: 0,
    misses: 0,
    writes: 0,
    writeFailures: 0,
    selections: 0,
    selectionHits: 0,
    escapes: 0,
    timeouts: 0,
    readFailures: 0,
    staleServes: 0,
    breakerSkips: 0,
    breakerTrips: 0,
  });
}
