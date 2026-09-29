#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Test suites for this repository are owned by fongap-labs/action-worker
// (tests/packs/<pack>) so a pull request cannot weaken its own tests.
// This wrapper runs that pack locally: `npm test [-- unit|gate|all]`.
// Central CI does not use it; it runs the same pack through action-worker.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, '.github', 'test-pack.json'), 'utf8'));
const tier = process.argv[2] ?? 'all';

let workerRoot = process.env.ACTION_WORKER_ROOT;
if (!workerRoot) {
  workerRoot = join(root, '.cache', 'action-worker');
  const git = (...args) => spawnSync('git', args, { stdio: 'inherit' });
  if (!existsSync(workerRoot)) {
    git('clone', '--quiet', 'https://github.com/fongap-labs/action-worker.git', workerRoot);
  }
  git('-C', workerRoot, 'fetch', '--quiet', 'origin', config.ref);
  git('-C', workerRoot, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
}

const result = spawnSync(
  process.execPath,
  [join(workerRoot, 'tests', 'run-pack.mjs'), config.pack, root, tier],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
