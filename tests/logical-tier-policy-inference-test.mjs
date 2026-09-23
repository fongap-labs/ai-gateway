#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import assert from 'node:assert/strict';
import { getPolicy, loadPoliciesConfig } from '../src/config/policies.ts';

const policies = loadPoliciesConfig({});

const auditUltra = getPolicy('Audit-Ultra', {}, policies);
assert.equal(auditUltra.maxAttempts, 6);
assert.equal(auditUltra.headersTimeoutMs, 60_000);
assert.equal(auditUltra.firstEventTimeoutMs, 60_000);
assert.equal(auditUltra.failoverBudgetMs, 180_000);

const editorAir = getPolicy('Editor-Air', {}, policies);
assert.equal(editorAir.maxAttempts, 4);
assert.equal(editorAir.failoverBudgetMs, 60_000);

const explicit = getPolicy(
  'Audit-Ultra',
  { 'Audit-Ultra': { policy: 'fast' } },
  policies,
);
assert.equal(explicit.maxAttempts, 4);
assert.equal(explicit.failoverBudgetMs, 60_000);

const unrelated = getPolicy('custom-model', {}, policies);
assert.equal(unrelated.maxAttempts, 5);
assert.equal(unrelated.headersTimeoutMs, null);

console.log('logical tier policy inference tests passed.');
