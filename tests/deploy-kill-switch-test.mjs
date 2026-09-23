#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const root = join(currentDir, '..');
const deploy = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');

const gateIf = deploy.split(/\r?\n/).find((line) =>
  line.includes("vars.AIG_IS_DEPLOY_ENABLED != 'false'"),
)?.trim() || '';

assert.ok(
  gateIf.includes("vars.AIG_IS_DEPLOY_ENABLED != 'false'"),
  'deployment must be enabled unless AIG_IS_DEPLOY_ENABLED is explicitly false',
);
assert.doesNotMatch(
  deploy,
  /AIG_DEPLOY_REPOSITORY/,
  'deployment repository identity must come from GitHub context',
);
assert.doesNotMatch(
  gateIf,
  /fongap(?:-labs)?\/ai-gateway/,
  'deployment identity must not be hard-coded in the workflow gate',
);

console.log('deploy gate contract tests passed.');
