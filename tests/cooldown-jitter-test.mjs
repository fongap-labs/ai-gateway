#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import assert from 'node:assert/strict';
import { COOLDOWN_JITTER_FACTOR, jitterCooldownMs } from '../src/reliability/cooldown-jitter.ts';

assert.equal(COOLDOWN_JITTER_FACTOR, 0.1);
assert.equal(jitterCooldownMs(0, 0), 0);
assert.equal(jitterCooldownMs(-100, 1), -100);
assert.equal(jitterCooldownMs(1_000, 0), 900);
assert.equal(jitterCooldownMs(1_000, 0.5), 1_000);
assert.equal(jitterCooldownMs(1_000, 1), 1_100);
assert.equal(jitterCooldownMs(333, 0), 300);
assert.equal(jitterCooldownMs(333, 1), 366);

console.log('cooldown-jitter-test passed');
