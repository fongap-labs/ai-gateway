#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const central = fs.readFileSync(path.join(root, '.github', 'scripts', 'central-ci.sh'), 'utf8');
const migrationsCheck = fs.readFileSync(path.join(root, 'scripts', 'migrations-check.mjs'), 'utf8');

assert.match(workflow, /run-central-ci-ref/, 'main CI must dispatch to Action Worker');
assert.match(central, /npm run validate:merge/, 'central CI must execute merge validation with full checkout history');
assert.match(central, /CENTRAL_CI_PR_NUMBER/, 'central CI must distinguish PR and default-branch validation');
assert.ok(!/skipping immutability check/i.test(migrationsCheck));
assert.match(migrationsCheck, /immutability check requires complete git history/);

console.log('CI migration immutability contract passed.');
