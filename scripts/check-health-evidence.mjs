#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Offline regression for configuration-vs-success health and Worker startup clock.

import assert from 'node:assert/strict';
import { gatewayStats, startGatewayStats } from '../src/observability/gateway-stats.ts';
import { summarizeHealthEvidence } from '../src/observability/health-evidence.ts';
import { startTokenStats, summarizeTokenStats, tokenStats } from '../src/observability/token-usage.ts';

const endpoints = [
  { status: 'configured', total_successes: 0 },
  { status: 'observed_healthy', total_successes: 0 }, // TTFT only; no completed answer
  { status: 'unknown', total_successes: 2 }, // buffered, completed answer
  { status: 'cooldown', total_successes: 1 },
  { status: 'disabled', total_successes: 0 },
  { status: 'active', total_successes: 0 }, // Tier 2 default; not evidence
];
const result = summarizeHealthEvidence(endpoints, 6);
assert.equal(result.observedHealthy, 1);
assert.equal(result.observedResponsive, 1);
assert.equal(result.unknown, 3);
assert.equal(result.cooling, 1);
assert.equal(result.disabled, 1);
assert.equal(result.configuredWithoutAccountBlock, 4);

const unobserved = summarizeHealthEvidence([{ status: 'configured', total_successes: 0 }], 1);
assert.equal(unobserved.observedHealthy, 0);
assert.equal(unobserved.unknown, 1);
assert.equal(unobserved.configuredWithoutAccountBlock, 1);

const firstRequest = 1_800_000_000_000;
gatewayStats.startedAt = 0;
tokenStats.startedAt = 0;
startGatewayStats(firstRequest);
startTokenStats(firstRequest);
assert.equal(gatewayStats.startedAt, firstRequest);
assert.equal(summarizeTokenStats().startedAt, firstRequest);
startGatewayStats(firstRequest + 1000);
startTokenStats(firstRequest + 1000);
assert.equal(gatewayStats.startedAt, firstRequest);
assert.equal(tokenStats.startedAt, firstRequest);
assert.ok(new Date(gatewayStats.startedAt).getUTCFullYear() >= 2026);
console.log('Health evidence and Worker startup timestamp contracts passed offline.');
