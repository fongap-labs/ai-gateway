#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Runtime fixture test for the secret scanner. The fixtures are generated in a
// temporary directory so secret-looking strings never live in the repository.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanner = path.join(root, 'scripts', 'secret-scan.mjs');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-secret-scan-'));

try {
  const fakeKey = 's' + 'k-' + 'A'.repeat(24);
  for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
    fs.writeFileSync(path.join(fixtureRoot, `fixture${ext}`), `export const leaked = '${fakeKey}';\n`, 'utf8');
  }

  const result = spawnSync(process.execPath, [scanner, '--root', fixtureRoot], {
    cwd: root,
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;

  assert.equal(result.status, 1, 'secret scanner must reject TypeScript fixtures containing a fake secret');
  for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
    assert.ok(output.includes(`fixture${ext}`),
      `scanner output must include the ${ext} fixture`);
  }
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('secret scanner TypeScript fixture test passed.');
