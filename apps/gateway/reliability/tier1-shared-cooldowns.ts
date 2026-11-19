import type { ExecutionContextLike, GatewayEnv } from '../../../packages/contracts/runtime.ts';
import { adoptTier1Cooldown, type Tier1SharedCooldown, tier1LongCooldowns } from '../../../src/reliability/tier1-state.ts';

const KV_BINDING = 'TIER1_AFFINITY';
export const SHARED_COOLDOWNS_KEY = 'tier1-cooldowns:v1';
export const SHARED_COOLDOWN_MIN_MS = 5 * 60_000;
const REFRESH_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 50;
const READ_RETRY_MS = 15_000;
const MIN_KV_TTL_SECONDS = 60;
export const SHARED_COOLDOWN_WRITE_RETRY_MS = 60_000;

type CooldownKV = {
  get(key: string): Promise<string | null | undefined>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

let known: Tier1SharedCooldown[] = [];
let readAt = Number.NEGATIVE_INFINITY;
let readRetryAfter = 0;
let readGeneration = 0;
let isWriting = false;
let isDirty = false;
let isWriteRetryPending = false;
let writeRetryAfter = 0;
const kvStats = { reads: 0, readFailures: 0, writes: 0, writeFailures: 0 };
const failedRegistrations = new WeakMap<object, Promise<void>[]>();

export function snapshotSharedTier1Cooldowns() {
  return { binding: KV_BINDING, ...kvStats, knownEntries: known.length };
}

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

function isNews(entry: Tier1SharedCooldown): boolean {
  const current = known.find((candidate) => entryKey(candidate) === entryKey(entry));
  return isWriteRetryPending || !current || entry.until - current.until >= SHARED_COOLDOWN_MIN_MS;
}

function merge(a: Tier1SharedCooldown[], b: Tier1SharedCooldown[], now: number): Tier1SharedCooldown[] {
  const byKey = new Map<string, Tier1SharedCooldown>();
  for (const entry of [...a, ...b]) {
    if (entry.until <= now) continue;
    const current = byKey.get(entryKey(entry));
    if (!current || entry.until > current.until) byKey.set(entryKey(entry), entry);
  }
  return [...byKey.values()];
}

export async function hydrateSharedTier1Cooldowns(env: GatewayEnv, now: number = Date.now()): Promise<void> {
  const kv = kvOf(env);
  if (!kv || now < readRetryAfter || now - readAt < REFRESH_MS) return;
  readAt = now;
  const generation = ++readGeneration;
  const load = (async () => {
    try {
      kvStats.reads++;
      const entries = parseEntries(await kv.get(SHARED_COOLDOWNS_KEY));
      if (generation !== readGeneration) return;
      known = merge(known, entries, Date.now());
      for (const entry of entries) adoptTier1Cooldown(entry);
      readAt = Date.now();
      readRetryAfter = 0;
    } catch {
      kvStats.readFailures++;
      if (generation === readGeneration) {
        readAt = Number.NEGATIVE_INFINITY;
        readRetryAfter = Date.now() + READ_RETRY_MS;
      }
    }
  })();
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    timerId = setTimeout(() => {
      timedOut = true;
      resolve();
    }, READ_TIMEOUT_MS);
  });
  try {
    await Promise.race([load, timeout]);
  } finally {
    clearTimeout(timerId);
  }
  if (timedOut && generation === readGeneration) {
    readGeneration++;
    readAt = Number.NEGATIVE_INFINITY;
    readRetryAfter = Date.now() + READ_RETRY_MS;
  }
}

export function shareLongTier1Cooldowns(env: GatewayEnv, ctx: ExecutionContextLike | undefined, accountId: string, now: number = Date.now()): void {
  const kv = kvOf(env);
  if (!kv || now < writeRetryAfter) return;
  const fresh = tier1LongCooldowns(accountId, SHARED_COOLDOWN_MIN_MS, now).filter(isNews);
  if (fresh.length === 0) return;
  known = merge(known, fresh, now);
  if (isWriting) {
    isDirty = true;
    return;
  }
  const task = flush(kv);
  let registered = false;
  if (ctx && typeof ctx.waitUntil === 'function') {
    try {
      ctx.waitUntil(task);
      registered = true;
    } catch {}
  }
  if (!registered && ctx && typeof ctx === 'object') {
    const pending = failedRegistrations.get(ctx) ?? [];
    pending.push(task);
    failedRegistrations.set(ctx, pending);
  }
}

export async function waitForSharedTier1CooldownWrites(ctx: object): Promise<void> {
  const pending = failedRegistrations.get(ctx);
  if (!pending) return;
  failedRegistrations.delete(ctx);
  await Promise.allSettled(pending);
}

async function flush(kv: CooldownKV): Promise<void> {
  isWriting = true;
  try {
    do {
      isDirty = false;
      kvStats.reads++;
      let prior: string | null | undefined;
      try {
        prior = await kv.get(SHARED_COOLDOWNS_KEY);
      } catch {
        kvStats.readFailures++;
        throw new Error('Shared cooldown KV read failed');
      }
      known = merge(parseEntries(prior), known, Date.now());
      if (known.length === 0) break;
      const latest = Math.max(...known.map((entry) => entry.until));
      const ttl = Math.max(MIN_KV_TTL_SECONDS, Math.ceil((latest - Date.now()) / 1000));
      try {
        await kv.put(SHARED_COOLDOWNS_KEY, JSON.stringify(known), { expirationTtl: ttl });
        kvStats.writes++;
        isWriteRetryPending = false;
        writeRetryAfter = 0;
      } catch {
        kvStats.writeFailures++;
        throw new Error('Shared cooldown KV write failed');
      }
    } while (isDirty);
  } catch {
    isWriteRetryPending = true;
    writeRetryAfter = Date.now() + SHARED_COOLDOWN_WRITE_RETRY_MS;
  } finally {
    isWriting = false;
  }
}

export function __resetSharedTier1CooldownsForTests(): void {
  known = [];
  readAt = Number.NEGATIVE_INFINITY;
  readRetryAfter = 0;
  readGeneration++;
  isWriting = false;
  isDirty = false;
  isWriteRetryPending = false;
  writeRetryAfter = 0;
  kvStats.reads = 0;
  kvStats.readFailures = 0;
  kvStats.writes = 0;
  kvStats.writeFailures = 0;
}
