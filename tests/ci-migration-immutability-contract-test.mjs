#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// CI contract for D1 migration immutability. Required CI must always have
// enough git history to compare applied migrations, and the governance script
// must fail closed instead of silently skipping the immutable-history check.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const migrationsCheck = fs.readFileSync(path.join(root, 'scripts', 'migrations-check.mjs'), 'utf8');

const fullHistoryCount = (workflow.match(/fetch-depth:\s*0/g) || []).length;
assert.equal(fullHistoryCount, 2,
  'both validate-merge and validate-deploy checkout steps must use fetch-depth: 0');

assert.ok(!/skipping immutability check/i.test(migrationsCheck),
  'migration governance must never silently skip the immutability check');

assert.match(migrationsCheck, /immutability check requires complete git history/,
  'migration governance must fail closed when a base commit cannot be resolved');

console.log('CI migration immutability contract passed.');
