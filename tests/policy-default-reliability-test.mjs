#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { loadPoliciesConfig, getPolicy, getPoliciesConfigDiagnostics } from '../src/config/policies.ts';
import { loadModelsConfig } from '../src/config/models.ts';

const builtins = loadPoliciesConfig({});
assert.equal(builtins.fast.failoverBudgetMs, 60_000);
assert.equal(builtins['long-reasoning'].failoverBudgetMs, 180_000);
assert.equal(builtins['long-reasoning'].maxAttempts, 3);

const inferredModels = loadModelsConfig({
  AIG_MODELS_CONFIG: JSON.stringify({
    'Code-Air': {},
    'Code-Pro': {},
    'Code-Max': {},
    'Code-Ultra': {},
    Other: {},
  }),
});

assert.equal(getPolicy('Code-Air', inferredModels, builtins), builtins.fast);
assert.equal(getPolicy('Code-Pro', inferredModels, builtins), builtins['long-reasoning']);
assert.equal(getPolicy('Code-Max', inferredModels, builtins), builtins['long-reasoning']);
assert.equal(getPolicy('Code-Ultra', inferredModels, builtins), builtins['long-reasoning']);
assert.equal(getPolicy('Other', inferredModels, builtins), builtins.default);

const customPolicies = loadPoliciesConfig({
  AIG_POLICIES_CONFIG: JSON.stringify({
    review: { max_attempts: 4, failover_budget_ms: 240000, hedge: { enabled: false } },
  }),
});
const explicitModels = loadModelsConfig({
  AIG_MODELS_CONFIG: JSON.stringify({
    'Code-Pro': { policy: 'review' },
  }),
});
assert.equal(getPolicy('Code-Pro', explicitModels, customPolicies), customPolicies.review);
assert.equal(customPolicies.review.failoverBudgetMs, 240_000);

const invalidEnv = {
  AIG_POLICIES_CONFIG: JSON.stringify({
    review: { max_attempts: 3, failover_budget_ms: 2000, first_event_timeout_ms: 5000 },
  }),
};
assert.ok(
  getPoliciesConfigDiagnostics(invalidEnv).some((d) => d.includes('first_event_timeout_ms') && d.includes('effective failover budget')),
);

console.log('policy default reliability tests passed.');
