// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Passive, bounded, isolate-local evidence of physical dispatch outcomes.
// No probes, storage writes, raw prompts, credentials or upstream error bodies.
const MINUTE_MS = 60_000;
const WINDOW_MS = 15 * MINUTE_MS;
const MAX_BUCKETS = 600;
const MAX_ROWS = 80;
type Counts = {
  successes: number;
  http_429: number;
  http_422: number;
  http_503: number;
  stream_interruptions: number;
  timeouts: number;
  other_failures: number;
};
type Bucket = Counts & {
  node_id: string;
  upstream_model: string;
  surface: string;
  minute: number;
};
const buckets = new Map<string, Bucket>();
let droppedEvents = 0;
const empty = (): Counts => ({ successes: 0, http_429: 0, http_422: 0, http_503: 0, stream_interruptions: 0, timeouts: 0, other_failures: 0 });
const safe = (value: string): string => value.slice(0, 100);

function prune(now: number): void {
  const cutoff = Math.floor((now - WINDOW_MS) / MINUTE_MS) * MINUTE_MS;
  for (const [key, bucket] of buckets) if (bucket.minute <= cutoff) buckets.delete(key);
}

export function recordProviderAttemptEvidence(
  { nodeId, upstreamModel, surface, status, kind }: { nodeId: string; upstreamModel: string; surface: string; status: number; kind: string },
  now: number = Date.now(),
): void {
  if (!Number.isFinite(now) || now <= 0) return;
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const dims = [safe(nodeId), safe(upstreamModel), safe(surface)] as const;
  const key = JSON.stringify([...dims, minute]);
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) prune(now);
    if (buckets.size >= MAX_BUCKETS) {
      droppedEvents++;
      return;
    }
    bucket = { ...empty(), node_id: dims[0], upstream_model: dims[1], surface: dims[2], minute };
    buckets.set(key, bucket);
  }
  if (kind === 'success') bucket.successes++;
  else if (kind === 'stream_interrupted') bucket.stream_interruptions++;
  else if (status === 429 || kind === 'rate_limit') bucket.http_429++;
  else if (status === 422) bucket.http_422++;
  else if (status === 503) bucket.http_503++;
  else if (kind === 'headers_timeout' || kind === 'first_event_timeout') bucket.timeouts++;
  else bucket.other_failures++;
}

export function snapshotProviderAttemptEvidence(now: number = Date.now()) {
  prune(now);
  const rows = new Map<string, Omit<Bucket, 'minute'>>();
  for (const bucket of buckets.values()) {
    const key = JSON.stringify([bucket.node_id, bucket.upstream_model, bucket.surface]);
    let row = rows.get(key);
    if (!row) {
      row = { ...empty(), node_id: bucket.node_id, upstream_model: bucket.upstream_model, surface: bucket.surface };
      rows.set(key, row);
    }
    row.successes += bucket.successes;
    row.http_429 += bucket.http_429;
    row.http_422 += bucket.http_422;
    row.http_503 += bucket.http_503;
    row.stream_interruptions += bucket.stream_interruptions;
    row.timeouts += bucket.timeouts;
    row.other_failures += bucket.other_failures;
  }
  const sorted = [...rows.values()].sort(
    (a, b) => b.http_429 + b.http_422 + b.http_503 + b.stream_interruptions - (a.http_429 + a.http_422 + a.http_503 + a.stream_interruptions),
  );
  return {
    scope: 'isolate-local',
    window_minutes: 15,
    rows: sorted.slice(0, MAX_ROWS),
    rows_truncated: sorted.length > MAX_ROWS,
    dropped_events: droppedEvents,
    note: 'Passive physical-attempt evidence only; not cluster-wide. Rows are grouped per node, upstream model and request surface.',
  };
}

export function __resetProviderAttemptEvidenceForTests(): void {
  buckets.clear();
  droppedEvents = 0;
}
