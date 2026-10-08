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

// The test-pack ref must be a full 40-character commit SHA, never a mutable
// branch name. A mutable ref lets a compromise of the action-worker repo
// execute arbitrary code on every contributor's machine that runs `npm test`.
if (!/^[0-9a-f]{40}$/.test(config.ref)) {
  console.error(`test-pack.json: ref must be a full 40-char commit SHA, got "${config.ref}".`);
  process.exit(64);
}

let workerRoot = process.env.ACTION_WORKER_ROOT;
if (!workerRoot) {
  workerRoot = join(root, '.cache', 'action-worker');
  const git = (...args) => spawnSync('git', args, { stdio: 'inherit' });
  if (!existsSync(workerRoot)) {
    git('clone', '--quiet', 'https://github.com/fongap-labs/action-worker.git', workerRoot);
  }
  git('-C', workerRoot, 'fetch', '--quiet', 'origin', config.ref);
  git('-C', workerRoot, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
  // Fail-closed: the checkout must match the pinned SHA exactly.
  const actual = spawnSync('git', ['-C', workerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  if (actual !== config.ref) {
    console.error(`test-pack: fetched HEAD ${actual} does not match pinned SHA ${config.ref}.`);
    process.exit(1);
  }
}

const result = spawnSync(process.execPath, [join(workerRoot, 'tests', 'run-pack.mjs'), config.pack, root, tier], { stdio: 'inherit' });
process.exit(result.status ?? 1);
