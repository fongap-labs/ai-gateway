#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Offline regression for bounded passive physical-dispatch outcome evidence.
import assert from 'node:assert/strict';
import {
  __resetProviderAttemptEvidenceForTests,
  recordProviderAttemptEvidence,
  snapshotProviderAttemptEvidence,
} from '../src/observability/provider-attempt-evidence.ts';

__resetProviderAttemptEvidenceForTests();
const start = 1_800_000_000_000;
const nodeId = 'free-key-1';
const model = 'physical-code-model';
const surface = 'responses';
const add = (status, kind, delta = 0, override = {}) =>
  recordProviderAttemptEvidence(
    {
      nodeId,
      upstreamModel: model,
      surface,
      status,
      kind,
      ...override,
    },
    start + delta,
  );
add(429, 'rate_limit');
add(422, 'client', 1000);
add(503, 'server', 2000);
add(0, 'headers_timeout', 3000);
add(0, 'stream_interrupted', 4000);
add(200, 'success', 5000);
add(200, 'success', 6000, { surface: 'chat_completions' });
let snapshot = snapshotProviderAttemptEvidence(start + 10_000);
assert.equal(snapshot.scope, 'isolate-local');
assert.equal(snapshot.rows.length, 2, 'two independent surfaces');
const responses = snapshot.rows.find((row) => row.surface === 'responses');
assert.ok(responses);
assert.equal(responses.node_id, nodeId);
assert.equal(responses.upstream_model, model);
assert.equal(responses.http_429, 1);
assert.equal(responses.http_422, 1);
assert.equal(responses.http_503, 1);
assert.equal(responses.timeouts, 1);
assert.equal(responses.stream_interruptions, 1);
assert.equal(responses.successes, 1);
assert.equal(snapshot.rows.find((row) => row.surface === 'chat_completions')?.successes, 1);
// After the sliding window expires, stale evidence no longer claims health.
snapshot = snapshotProviderAttemptEvidence(start + 17 * 60_000);
assert.deepEqual(snapshot.rows, []);
__resetProviderAttemptEvidenceForTests();
console.log('Passive per-node/model/surface evidence contracts passed offline.');
