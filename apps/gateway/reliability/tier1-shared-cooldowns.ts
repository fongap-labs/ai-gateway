import type { ExecutionContextLike, GatewayEnv } from '../../../packages/contracts/runtime.ts';
import { adoptTier1Cooldown, type Tier1SharedCooldown, tier1LongCooldowns } from '../../../src/reliability/tier1-state.ts';

const KV_BINDING = 'TIER1_AFFINITY';
export const SHARED_COOLDOWN_KEY_PREFIX = 'tier1-cooldown:v1:';
const keyForNode = (nodeId: string): string => SHARED_COOLDOWN_KEY_PREFIX + nodeId;
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
const readAtByNode = new Map<string, number>();
const readRetryAfterByNode = new Map<string, number>();
const readGenerations = new Map<string, number>();
let readGeneration = 0;
const writing = new Set<string>();
const dirty = new Set<string>();
const writeRetryPending = new Set<string>();
const writeRetryAfterByNode = new Map<string, number>();
const kvStats = { reads: 0, readFailures: 0, writes: 0, writeFailures: 0 };
const failedRegistrations = new WeakMap<object, Promise<void>[]>();

export function snapshotSharedTier1Cooldowns() {
  return { binding: KV_BINDING, ...kvStats, knownEntries: known.length };
}

function kvOf(env: GatewayEnv): CooldownKV | null {
  const kv = env?.[KV_BINDING] as Partial<CooldownKV> | null | undefined;
  return kv && typeof kv.get === 'function' && typeof kv.put === 'function' ? (kv as CooldownKV) : null;
}

function parseEntries(value: unknown, nodeId: string): Tier1SharedCooldown[] {
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
    if (node !== nodeId || typeof until !== 'number' || !Number.isFinite(until) || typeof reason !== 'string') continue;
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
  return writeRetryPending.has(entry.node) || !current || entry.until - current.until >= SHARED_COOLDOWN_MIN_MS;
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

export async function hydrateSharedTier1Cooldowns(
  env: GatewayEnv,
  now: number = Date.now(),
  activeNodeIds: ReadonlyArray<string> = [],
): Promise<void> {
  const kv = kvOf(env);
  if (!kv || activeNodeIds.length === 0) return;
  await Promise.all(
    [...new Set(activeNodeIds)].map(async (nodeId) => {
      if (!nodeId || now < (readRetryAfterByNode.get(nodeId) ?? 0) || now - (readAtByNode.get(nodeId) ?? Number.NEGATIVE_INFINITY) < REFRESH_MS) {
        return;
      }
      readAtByNode.set(nodeId, now);
      const generation = ++readGeneration;
      readGenerations.set(nodeId, generation);
      const load = (async () => {
        try {
          kvStats.reads++;
          const entries = parseEntries(await kv.get(keyForNode(nodeId)), nodeId);
          if (readGenerations.get(nodeId) !== generation) return;
          known = merge(known, entries, Date.now());
          for (const entry of entries) adoptTier1Cooldown(entry);
          readAtByNode.set(nodeId, Date.now());
          readRetryAfterByNode.delete(nodeId);
        } catch {
          kvStats.readFailures++;
          if (readGenerations.get(nodeId) === generation) {
            readAtByNode.delete(nodeId);
            readRetryAfterByNode.set(nodeId, Date.now() + READ_RETRY_MS);
          }
        }
      })();
      let timerId: ReturnType<typeof setTimeout> | undefined;
      let hasTimedOut = false;
      const timeout = new Promise<void>((resolve) => {
        timerId = setTimeout(() => {
          hasTimedOut = true;
          resolve();
        }, READ_TIMEOUT_MS);
      });
      try {
        await Promise.race([load, timeout]);
      } finally {
        clearTimeout(timerId);
      }
      if (hasTimedOut && readGenerations.get(nodeId) === generation) {
        readGenerations.set(nodeId, ++readGeneration);
        readAtByNode.delete(nodeId);
        readRetryAfterByNode.set(nodeId, Date.now() + READ_RETRY_MS);
      }
    }),
  );
}

export function shareLongTier1Cooldowns(env: GatewayEnv, ctx: ExecutionContextLike | undefined, accountId: string, now: number = Date.now()): void {
  const kv = kvOf(env);
  if (!kv || now < (writeRetryAfterByNode.get(accountId) ?? 0)) return;
  const fresh = tier1LongCooldowns(accountId, SHARED_COOLDOWN_MIN_MS, now).filter(isNews);
  if (fresh.length === 0) return;
  known = merge(known, fresh, now);
  if (writing.has(accountId)) {
    dirty.add(accountId);
    return;
  }
  const task = flush(kv, accountId);
  let isRegistered = false;
  if (ctx && typeof ctx.waitUntil === 'function') {
    try {
      ctx.waitUntil(task);
      isRegistered = true;
    } catch {}
  }
  if (!isRegistered && ctx && typeof ctx === 'object') {
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

async function flush(kv: CooldownKV, nodeId: string): Promise<void> {
  writing.add(nodeId);
  try {
    do {
      dirty.delete(nodeId);
      kvStats.reads++;
      let prior: string | null | undefined;
      try {
        prior = await kv.get(keyForNode(nodeId));
      } catch {
        kvStats.readFailures++;
        throw new Error('Shared cooldown KV read failed');
      }
      const entries = merge(
        parseEntries(prior, nodeId),
        known.filter((entry) => entry.node === nodeId),
        Date.now(),
      );
      known = merge(known, entries, Date.now());
      if (entries.length === 0) break;
      const latest = Math.max(...entries.map((entry) => entry.until));
      const ttl = Math.max(MIN_KV_TTL_SECONDS, Math.ceil((latest - Date.now()) / 1000));
      try {
        await kv.put(keyForNode(nodeId), JSON.stringify(entries), { expirationTtl: ttl });
        kvStats.writes++;
        writeRetryPending.delete(nodeId);
        writeRetryAfterByNode.delete(nodeId);
      } catch {
        kvStats.writeFailures++;
        throw new Error('Shared cooldown KV write failed');
      }
    } while (dirty.has(nodeId));
  } catch {
    writeRetryPending.add(nodeId);
    writeRetryAfterByNode.set(nodeId, Date.now() + SHARED_COOLDOWN_WRITE_RETRY_MS);
  } finally {
    writing.delete(nodeId);
  }
}

export function __resetSharedTier1CooldownsForTests(): void {
  known = [];
  readAtByNode.clear();
  readRetryAfterByNode.clear();
  readGenerations.clear();
  readGeneration++;
  writing.clear();
  dirty.clear();
  writeRetryPending.clear();
  writeRetryAfterByNode.clear();
  kvStats.reads = 0;
  kvStats.readFailures = 0;
  kvStats.writes = 0;
  kvStats.writeFailures = 0;
}
