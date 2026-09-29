// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Per-group in-isolate sliding-window rate limiter for the gateway
// access key. Single-isolate, in-memory; same model as
// node-state.ts's RPM bucket. The cap is enforced before any
// upstream work happens, so an abused key never gets to consume a
// tier node's slot.
//
// This limiter is intentionally isolate-local (per Cloudflare Workers isolate).
// The gateway does not currently claim a strict account-wide / multi-isolate
// RPM cap. Under horizontal scaling, a distributed client can exceed the
// nominal RPM by a factor equal to the number of isolates. For hard
// account-wide limits, use Cloudflare WAF Rate Limiting or a Durable Object
// counter. See SECURITY.md "Rate limiting boundary" for details.
//
// Design:
//   * window is 60s, ring of timestamps for the active window;
//   * the cap is set via the AIG_ACCESS_KEY_RPM env var; 0 disables;
//   * the limiter is keyed on the gateway access-key GROUP (not per-key)
//     so all keys in the same group share the cap;
//   * a denied request returns 429 with Retry-After: <seconds until
//     the oldest stamp falls out of the window>;
//   * a denied request returns 429 with Retry-After: <seconds until
//     the oldest stamp falls out of the window>;
//   * bounded by the number of distinct keys the gateway has seen
//     in the current isolate — the map is capped and old keys are
//     evicted.

type KeyStateEntry = {
  stamps: number[];
  lastSeen: number;
  cap: number;
};

type KeyAdmissionVerdict = { ok: true } | { ok: false; retryAfterSec: number };

const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 5_000;

const keyState: Map<string, KeyStateEntry> = new Map();

function evictStale(now: number): void {
  if (keyState.size <= MAX_TRACKED_KEYS) return;
  // Drop the entry with the smallest lastSeen (oldest un-observed key).
  let oldest: [string, KeyStateEntry] | null = null;
  for (const [k, v] of keyState) {
    if (oldest === null || v.lastSeen < oldest[1].lastSeen) oldest = [k, v];
  }
  if (oldest) keyState.delete(oldest[0]);
}

function pruneWindow(stamps: number[], now: number): void {
  const cutoff = now - WINDOW_MS;
  let drop = 0;
  while (drop < stamps.length && (stamps[drop] ?? Infinity) < cutoff) drop += 1;
  if (drop > 0) stamps.splice(0, drop);
}

/**
 * Try to admit one request from `groupFingerprint` against the per-group
 * RPM cap. Returns { ok: true } when admitted, or { ok: false, retryAfterSec }
 * when the cap is exceeded.
 *
 * `groupFingerprint` is the gateway access-key group label (e.g., "air", "pro")
 * — see `preflight.ts` for how the group is resolved from the auth result.
 *
 * `cap` is the RPM cap (0 = disabled). `now` is injectable for tests.
 */
export function admitKeyRequest(groupFingerprint: string, cap: number, now: number = Date.now()): KeyAdmissionVerdict {
  if (!cap || cap <= 0) return { ok: true };
  let entry = keyState.get(groupFingerprint);
  if (!entry) {
    entry = { stamps: [], lastSeen: now, cap };
    keyState.set(groupFingerprint, entry);
    evictStale(now);
  }
  pruneWindow(entry.stamps, now);
  entry.lastSeen = now;
  entry.cap = cap;
  if (entry.stamps.length >= cap) {
    const oldest = entry.stamps[0];
    if (oldest === undefined) return { ok: true };
    const retryAfterMs = Math.max(1, oldest + WINDOW_MS - now);
    return { ok: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }
  entry.stamps.push(now);
  return { ok: true };
}

export function getKeyRpmSnapshot(groupFingerprint: string, now: number = Date.now()): { used: number; cap: number } {
  const entry = keyState.get(groupFingerprint);
  if (!entry) return { used: 0, cap: 0 };
  pruneWindow(entry.stamps, now);
  return { used: entry.stamps.length, cap: entry.cap };
}

export function __resetKeyRpmForTests(): void {
  keyState.clear();
}
