// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Long Tier 1 cooldowns shared across isolates. Tier 1 state lives in isolate
// memory, so every new isolate used to spend a real request rediscovering that a
// key's credential is rejected or its daily quota is gone. Cooldowns that are
// long-lived evidence (see Tier1SharedCooldown) and still have at least
// SHARED_COOLDOWN_MIN_MS to run are written to one KV key; an isolate reads it
// at most once per REFRESH_MS and adopts the entries.
//
// Best effort by design: KV is eventually consistent, two isolates writing at
// once can drop an entry, and a read that is slow does not hold the request.
// Losing an entry only costs one more failed request, as before. Entries are
// never cleared early: none of the shared kinds ends before its deadline.
//
// Stored value: JSON array of { node, model?, until (epoch ms), reason, quota? }.

import type { ExecutionContextLike, GatewayEnv } from '../types/runtime.ts';
import { adoptTier1Cooldown, type Tier1SharedCooldown, tier1LongCooldowns } from './tier1-state.ts';

const KV_BINDING = 'TIER1_AFFINITY';
export const SHARED_COOLDOWNS_KEY = 'tier1-cooldowns:v1';
export const SHARED_COOLDOWN_MIN_MS = 5 * 60_000;
const REFRESH_MS = 60_000;
const READ_TIMEOUT_MS = 50;
const MIN_KV_TTL_SECONDS = 60;

type CooldownKV = {
  get(key: string): Promise<string | null | undefined>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

let known: Tier1SharedCooldown[] = [];
let readAt = Number.NEGATIVE_INFINITY;
let isWriting = false;
let isDirty = false;

function kvOf(env: GatewayEnv): CooldownKV | null {
  const kv = env?.[KV_BINDING] as Partial<CooldownKV> | null | undefined;
  return kv && typeof kv.get === 'function' && typeof kv.put === 'function' ? (kv as CooldownKV) : null;
}

function parseEntries(value: unknown): Tier1SharedCooldown[] {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : null;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: Tier1SharedCooldown[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const { node, model, until, reason, quota } = raw as Record<string, unknown>;
    if (typeof node !== 'string' || typeof until !== 'number' || !Number.isFinite(until) || typeof reason !== 'string') continue;
    entries.push({
      node,
      until,
      reason,
      ...(typeof model === 'string' && model ? { model } : {}),
      ...(quota === true ? { quota: true } : {}),
    });
  }
  return entries;
}

const entryKey = (entry: Tier1SharedCooldown): string => `${entry.node}\u0000${entry.model ?? ''}`;

// Union by (node, model), keeping the later deadline, without expired entries.
function merge(a: Tier1SharedCooldown[], b: Tier1SharedCooldown[], now: number): Tier1SharedCooldown[] {
  const byKey = new Map<string, Tier1SharedCooldown>();
  for (const entry of [...a, ...b]) {
    if (entry.until <= now) continue;
    const current = byKey.get(entryKey(entry));
    if (!current || entry.until > current.until) byKey.set(entryKey(entry), entry);
  }
  return [...byKey.values()];
}

/** Adopt the cooldowns other isolates shared. Waits at most READ_TIMEOUT_MS. */
export async function hydrateSharedTier1Cooldowns(env: GatewayEnv, now: number = Date.now()): Promise<void> {
  const kv = kvOf(env);
  if (!kv || now - readAt < REFRESH_MS) return;
  readAt = now;
  const load = (async () => {
    try {
      const entries = parseEntries(await kv.get(SHARED_COOLDOWNS_KEY));
      known = merge(known, entries, Date.now());
      for (const entry of entries) adoptTier1Cooldown(entry);
    } catch {
      /* sharing is advisory; a failed read leaves local state unchanged */
    }
  })();
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timerId = setTimeout(resolve, READ_TIMEOUT_MS);
  });
  try {
    await Promise.race([load, timeout]);
  } finally {
    clearTimeout(timerId);
  }
}

/** Publish any long cooldown this account now carries. Writes are coalesced. */
export function shareLongTier1Cooldowns(env: GatewayEnv, ctx: ExecutionContextLike | undefined, accountId: string, now: number = Date.now()): void {
  const kv = kvOf(env);
  if (!kv) return;
  const fresh = tier1LongCooldowns(accountId, SHARED_COOLDOWN_MIN_MS, now);
  if (fresh.length === 0) return;
  known = merge(known, fresh, now);
  if (isWriting) {
    isDirty = true;
    return;
  }
  const task = flush(kv);
  try {
    ctx?.waitUntil?.(task);
  } catch {
    /* the write still runs; it is only not extended past the response */
  }
}

async function flush(kv: CooldownKV): Promise<void> {
  isWriting = true;
  try {
    do {
      isDirty = false;
      // Merge with what other isolates wrote since this one last read.
      known = merge(parseEntries(await kv.get(SHARED_COOLDOWNS_KEY)), known, Date.now());
      if (known.length === 0) break;
      const latest = Math.max(...known.map((entry) => entry.until));
      const ttl = Math.max(MIN_KV_TTL_SECONDS, Math.ceil((latest - Date.now()) / 1000));
      await kv.put(SHARED_COOLDOWNS_KEY, JSON.stringify(known), { expirationTtl: ttl });
    } while (isDirty);
  } catch {
    /* sharing is advisory; the local cooldown still applies */
  } finally {
    isWriting = false;
  }
}

export function __resetSharedTier1CooldownsForTests(): void {
  known = [];
  readAt = Number.NEGATIVE_INFINITY;
  isWriting = false;
  isDirty = false;
}
