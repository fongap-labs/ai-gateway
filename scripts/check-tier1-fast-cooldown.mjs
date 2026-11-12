#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Offline Key+model cooldown and 422 terminal response contracts.

import assert from 'node:assert/strict';
import { buildClientErrorResponse } from '../apps/gateway/response/errors.ts';
import { classifyUpstreamStatus } from '../src/reliability/classify.ts';
import {
  __resetTier1StateForTests,
  applyTier1Outcome,
  classifyTier1Failure,
  getTier1Model,
  recordTier1Success,
  TIER1_CIRCUIT_COOLDOWN_FLOOR_MS,
  TIER1_FAILURE_STREAK_WINDOW_MS,
  TIER1_FAST_COOLDOWN_MS,
} from '../src/reliability/tier1-state.ts';

const t = 1_000_000;
const server = classifyTier1Failure({ kind: 'server' });
const timeout = classifyTier1Failure({ kind: 'headers_timeout' });
__resetTier1StateForTests();

applyTier1Outcome('free-key-1', 'Code-Ultra', server, t);
const model = getTier1Model('free-key-1', 'Code-Ultra');
assert.equal(model.consecutiveFailures, 1);
assert.equal(model.cooldownUntil, 0);
applyTier1Outcome('free-key-1', 'Code-Ultra', timeout, t + 1);
assert.equal(model.consecutiveFailures, 2);
assert.equal(model.failureState, 'normal');
assert.ok(model.cooldownUntil >= t + 1 + TIER1_FAST_COOLDOWN_MS);
assert.equal(getTier1Model('free-key-1', 'General-Ultra').cooldownUntil, 0);
assert.equal(getTier1Model('free-key-2', 'Code-Ultra').cooldownUntil, 0);
const firstDeadline = model.cooldownUntil;
applyTier1Outcome('free-key-1', 'Code-Ultra', server, t + 2);
assert.equal(model.failureState, 'cooldown');
assert.equal(model.consecutiveFailures, 3);
assert.ok(model.cooldownUntil > firstDeadline);
assert.ok(model.cooldownUntil >= t + 2 + TIER1_CIRCUIT_COOLDOWN_FLOOR_MS);
recordTier1Success('free-key-1', 'Code-Ultra', model.cooldownUntil + 1);
assert.equal(model.consecutiveFailures, 0);
assert.equal(model.lastCountedFailureAt, 0);

// Isolated failures from separate windows never accumulate.
__resetTier1StateForTests();
applyTier1Outcome('free-key-1', 'Code-Ultra', server, t);
applyTier1Outcome('free-key-1', 'Code-Ultra', timeout, t + TIER1_FAILURE_STREAK_WINDOW_MS + 1);
assert.equal(getTier1Model('free-key-1', 'Code-Ultra').consecutiveFailures, 1);
assert.equal(getTier1Model('free-key-1', 'Code-Ultra').cooldownUntil, 0);

const rejected = classifyUpstreamStatus(422, new Headers(), {}, t, 'unprocessable');
assert.equal(rejected.action, 'stop');
assert.equal(rejected.counted, false);
applyTier1Outcome('free-key-1', 'Code-Ultra', classifyTier1Failure(rejected), t + TIER1_FAILURE_STREAK_WINDOW_MS + 2);
assert.equal(getTier1Model('free-key-1', 'Code-Ultra').consecutiveFailures, 1);

const response = buildClientErrorResponse(
  new Request('https://gateway.example/v1/chat/completions'),
  {},
  'openai_chat',
  'offline-request-id',
  'Code-Ultra',
  422,
  'private upstream details',
  { logicalAttempts: 4, dispatches: 4, hedges: 0, failureKinds: { server: 2, headers_timeout: 1, client: 1 }, attempts: [] },
  false,
);
assert.equal(response.status, 422);
const raw = await response.text();
const details = JSON.parse(raw).error.details;
assert.equal(details.attempts, 4);
assert.deepEqual(details.failure_kinds, { server: 2, headers_timeout: 1, client: 1 });
assert.ok(!raw.includes('private upstream details'));
__resetTier1StateForTests();
console.log('Tier 1 Key+model cooldown and terminal 422 diagnostics passed offline.');
