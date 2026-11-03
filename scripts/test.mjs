#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Central tests run from a pinned Action Worker commit.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, '.github', 'test-pack.json'), 'utf8'));
const tier = process.argv[2] ?? 'all';

// Reject mutable test-pack refs.
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
  const actual = spawnSync('git', ['-C', workerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  if (actual !== config.ref) {
    console.error(`test-pack: fetched HEAD ${actual} does not match pinned SHA ${config.ref}.`);
    process.exit(1);
  }
}

const result = spawnSync(process.execPath, [join(workerRoot, 'tests', 'run-pack.mjs'), config.pack, root, tier], { stdio: 'inherit' });
process.exit(result.status ?? 1);
