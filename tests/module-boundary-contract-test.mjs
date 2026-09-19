#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Stable module-boundary contract.
//
// This is intentionally conservative: it locks dependency directions that are
// already clean today. Known audit debts are documented in
// docs/architecture/module-boundary-audit.md and are not hidden by a test that
// the current tree cannot honestly satisfy.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(root, 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function moduleOf(file) {
  const rel = path.relative(srcRoot, file).replaceAll(path.sep, '/');
  return rel.split('/')[0];
}

function relativeSpecifiers(source) {
  const specs = [];
  const re = /(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(re)) {
    if (match[1].startsWith('.')) specs.push(match[1]);
  }
  return specs;
}

function targetModule(file, specifier) {
  const resolved = path.resolve(path.dirname(file), specifier);
  const rel = path.relative(srcRoot, resolved).replaceAll(path.sep, '/');
  if (rel.startsWith('../') || rel === '..') return 'outside-src';
  return rel.split('/')[0];
}

const rules = {
  config: new Set(['scheduler', 'reliability', 'request', 'transport', 'conversion', 'stream', 'dashboard', 'runtime', 'observability', 'ratelimit']),
  scheduler: new Set(['request', 'transport', 'protocol', 'conversion', 'stream', 'dashboard', 'runtime', 'observability', 'ratelimit']),
  reliability: new Set(['scheduler', 'request', 'transport', 'protocol', 'conversion', 'stream', 'dashboard', 'runtime', 'observability', 'ratelimit']),
  transport: new Set(['scheduler', 'reliability', 'request', 'conversion', 'dashboard', 'runtime', 'observability', 'ratelimit']),
  conversion: new Set(['scheduler', 'reliability', 'request', 'transport', 'dashboard', 'runtime', 'observability', 'ratelimit', 'config']),
  runtime: new Set(['request', 'scheduler', 'transport', 'protocol', 'conversion', 'stream', 'dashboard', 'ratelimit']),
  dashboard: new Set(['request', 'scheduler', 'reliability', 'transport', 'conversion', 'stream', 'ratelimit']),
  ratelimit: new Set(['request', 'scheduler', 'reliability', 'transport', 'protocol', 'conversion', 'stream', 'dashboard', 'runtime', 'observability']),
};

const violations = [];
for (const file of walk(srcRoot)) {
  const owner = moduleOf(file);
  const forbidden = rules[owner];
  if (!forbidden) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const specifier of relativeSpecifiers(source)) {
    const target = targetModule(file, specifier);
    if (target === owner) continue;
    if (forbidden.has(target)) {
      violations.push(`${path.relative(root, file).replaceAll(path.sep, '/')}: ${owner} -> ${target} (${specifier})`);
    }
  }
}
assert.deepEqual(violations, [], `module dependency direction violated:\n${violations.join('\n')}`);

const storeRoot = path.join(srcRoot, 'observability', 'token-usage-store');
const storeForbidden = new Set(['request', 'scheduler', 'reliability', 'transport', 'conversion', 'stream', 'dashboard', 'runtime', 'ratelimit', 'protocol']);
const storeViolations = [];
for (const file of walk(storeRoot)) {
  const source = fs.readFileSync(file, 'utf8');
  for (const specifier of relativeSpecifiers(source)) {
    const target = targetModule(file, specifier);
    if (storeForbidden.has(target)) {
      storeViolations.push(`${path.relative(root, file).replaceAll(path.sep, '/')}: observability store -> ${target} (${specifier})`);
    }
  }
}
assert.deepEqual(storeViolations, [], `persistent observability must stay routing-independent:\n${storeViolations.join('\n')}`);

const preflight = fs.readFileSync(path.join(srcRoot, 'request', 'preflight.ts'), 'utf8');
assert.ok(preflight.includes("../dashboard/pages.ts") && preflight.includes("../dashboard/readme-status.ts"),
  'request preflight remains the owner of local dashboard route dispatch');

const tier1State = fs.readFileSync(path.join(srcRoot, 'reliability', 'tier1-state.ts'), 'utf8');
const tier1Heat = fs.readFileSync(path.join(srcRoot, 'reliability', 'tier1-heat.ts'), 'utf8');
const tier1Scoring = fs.readFileSync(path.join(srcRoot, 'scheduler', 'tier1-scoring.ts'), 'utf8');
assert.doesNotMatch(tier1State, /calculateTier1Score|TIER1_SCORE_BASE|tier1ProviderModelHeatFactor|recordTier1ProviderModelRateLimit/,
  'Tier 1 state must not regain scheduler scoring or provider-model heat policy');
assert.match(tier1Scoring, /export function calculateTier1Score/,
  'Tier 1 score construction stays scheduler-owned');
assert.match(tier1Scoring, /tier1ProviderModelHeatFactor/,
  'scheduler scoring consumes heat through the heat owner');
assert.match(tier1Heat, /export function tier1ProviderModelHeatFactor/,
  'provider-model heat stays in reliability/tier1-heat.ts');
assert.match(tier1Heat, /export function recordTier1ProviderModelRateLimit/,
  'provider-model 429 observations stay in reliability/tier1-heat.ts');

const nodeState = fs.readFileSync(path.join(srcRoot, 'reliability', 'node-state.ts'), 'utf8');
const cooldownJitter = fs.readFileSync(path.join(srcRoot, 'reliability', 'cooldown-jitter.ts'), 'utf8');
assert.match(cooldownJitter, /export function jitterCooldownMs/,
  'automatic cooldown jitter arithmetic has one reliability owner');
assert.match(nodeState, /from '\.\/cooldown-jitter\.ts'/,
  'generic node reliability consumes the shared cooldown jitter primitive');
assert.match(tier1State, /from '\.\/cooldown-jitter\.ts'/,
  'Tier 1 reliability consumes the shared cooldown jitter primitive');
assert.doesNotMatch(nodeState, /const JITTER_FACTOR|function maybeJitter/,
  'generic node state must not regain private cooldown jitter arithmetic');
assert.doesNotMatch(tier1State, /const JITTER_FACTOR|function jitter\(/,
  'Tier 1 state must not regain private cooldown jitter arithmetic');

const successDispatcher = fs.readFileSync(path.join(srcRoot, 'request', 'attempt', 'success.ts'), 'utf8');
const successStream = fs.readFileSync(path.join(srcRoot, 'request', 'attempt', 'success-stream.ts'), 'utf8');
const successObject = fs.readFileSync(path.join(srcRoot, 'request', 'attempt', 'success-object.ts'), 'utf8');
assert.match(successDispatcher, /handleStreamingSuccess/);
assert.match(successDispatcher, /handleObjectSuccess/);
assert.match(successDispatcher, /clientWantsStream && s\.upstreamWasStreaming/,
  'success dispatcher preserves the original streaming predicate');
assert.doesNotMatch(successDispatcher, /ensureFirstSseEvent|collectResponsesObject|collectAnthropicMessageObject|trackStreamResponse/,
  'success.ts must remain a thin dispatcher');
assert.match(successStream, /ensureFirstSseEvent/,
  'first-event commit guard stays in success-stream.ts');
assert.match(successStream, /trackStreamResponse/,
  'stream lifecycle wiring stays in success-stream.ts');
assert.doesNotMatch(successStream, /collectResponsesObject|collectAnthropicMessageObject|collectOpenAIStreamObject/,
  'complete-object assembly must not leak back into success-stream.ts');
assert.match(successObject, /collectResponsesObject/,
  'Responses object assembly stays in success-object.ts');
assert.match(successObject, /collectAnthropicMessageObject/,
  'Anthropic object assembly stays in success-object.ts');
assert.match(successObject, /collectOpenAIStreamObject/,
  'OpenAI object assembly stays in success-object.ts');
assert.doesNotMatch(successObject, /ensureFirstSseEvent/,
  'first-event guard must not leak into success-object.ts');

const classifySource = fs.readFileSync(path.join(srcRoot, 'reliability', 'classify.ts'), 'utf8');
const processingContract = fs.readFileSync(path.join(srcRoot, 'types', 'upstream-processing.ts'), 'utf8');
assert.ok(relativeSpecifiers(classifySource).includes('../types/upstream-processing.ts'),
  'reliability classification consumes the neutral upstream-processing contract');
assert.doesNotMatch(classifySource, /transport\/processing-error/,
  'reliability must not regain a transport dependency for upstream-processing failures');
assert.match(processingContract, /export const UPSTREAM_PROCESSING_ERROR/);
assert.match(processingContract, /export class UpstreamProcessingError/);
assert.equal(fs.existsSync(path.join(srcRoot, 'transport', 'processing-error.ts')), false,
  'retired transport-owned processing-error module must stay removed');

const audit = fs.readFileSync(path.join(root, 'docs/architecture/module-boundary-audit.md'), 'utf8');
assert.match(audit, /Baseline: `8e375078cbde553d91d71e1ed4784d790db2b390`/);
assert.match(audit, /All material P1\/P2 ownership findings .* are resolved/i);
assert.match(audit, /Tier 1 ownership/i);
assert.match(audit, /Success finalization/i);
assert.match(audit, /upstream-processing\.ts/);
assert.match(audit, /Automatic cooldown jitter/i);
assert.match(audit, /Intentional duplication/i);

console.log('module-boundary contract tests passed.');
