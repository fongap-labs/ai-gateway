// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Labs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const migDir = path.join(root, 'migrations');

const FILENAME_RE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;
const _MIGRATION_NUMBER_RE = /^(\d+)_/;

const DESTRUCTIVE_ALLOWLIST = new Set(['0007_drop_redundant_usage_indexes.sql']);

function listMigrations() {
  return fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function parseName(file) {
  const m = FILENAME_RE.exec(file);
  if (!m) return null;
  return { num: Number.parseInt(m[1], 10), slug: m[2] };
}

function checkMonotonicAndUnique(files) {
  const seen = new Map();
  for (const f of files) {
    const p = parseName(f);
    assert.ok(p, `migration file "${f}" does not match NNN_slug.sql pattern`);
    assert.ok(seen.get(p.num) === undefined, `duplicate migration number ${p.num} (${f} vs ${seen.get(p.num)})`);
    seen.set(p.num, f);
  }
  const nums = [...seen.keys()].sort((a, b) => a - b);
  for (let i = 1; i < nums.length; i += 1) {
    const prev = nums[i - 1];
    const cur = nums[i];
    assert.ok(cur - prev === 1, `migration numbers must be strictly consecutive: gap between ${prev} and ${cur}`);
  }
}

function checkIdempotent(files) {
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    const upper = sql.toUpperCase();
    const createMatches = upper.matchAll(/\bCREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\b/g);
    for (const match of createMatches) {
      const offset = match.index ?? 0;
      const after = upper.slice(offset, offset + 200);
      assert.ok(after.includes('IF NOT EXISTS'), `${f}: every CREATE must use IF NOT EXISTS so re-applies are no-ops (D1 has no migrations table)`);
    }
  }
}

function getBaseCommit() {
  const envBase = process.env.GITHUB_BASE_REF;
  if (envBase) {
    const r = spawnSync('git', ['merge-base', `origin/${envBase}`, 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) {
      return r.stdout.trim();
    }
    const r2 = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (r2.status === 0 && r2.stdout.trim()) {
      return r2.stdout.trim();
    }
  }
  const r3 = spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd: root, encoding: 'utf8' });
  if (r3.status === 0 && r3.stdout.trim()) {
    return r3.stdout.trim();
  }
  return null;
}

function isRootCommit() {
  const result = spawnSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) return false;
  return result.stdout.trim().split(/\s+/).filter(Boolean).length === 1;
}

function ensureHistory(baseCommit) {
  if (!baseCommit) return;
  const r = spawnSync('git', ['merge-base', '--is-ancestor', baseCommit, 'HEAD'], { cwd: root });
  if (r.status !== 0) {
    const baseBranch = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main';
    spawnSync('git', ['fetch', '--no-tags', '--depth=50', 'origin', baseBranch.replace('origin/', '')], { cwd: root, stdio: 'ignore' });
  }
}

function isCommentOnlyModification(baseCommit, file) {
  const r = spawnSync('git', ['diff', '--unified=0', baseCommit, '--', file], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return false;
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) continue;
    if (line.startsWith('-') || line.startsWith('+')) {
      const content = line.slice(1).trim();
      if (content === '' || content.startsWith('--')) continue;
      return false;
    }
  }
  return true;
}

function checkImmutability(files) {
  const baseCommit = getBaseCommit();
  if (!baseCommit) {
    if (isRootCommit()) {
      console.log('migrations:check: root baseline detected; immutability diff skipped.');
      return;
    }
    throw new Error('migrations:check: could not determine base commit; immutability check requires complete git history');
  }
  ensureHistory(baseCommit);

  const r = spawnSync('git', ['diff', '--name-status', baseCommit, '--', 'migrations/'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`migrations:check: git diff failed while checking immutability against ${baseCommit}`);
  }
  const lines = r.stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    const code = line.slice(0, 1);
    const file = line.slice(2).trim();
    if (!file.endsWith('.sql')) continue;
    if (code === 'A') continue;
    if (code === 'M' && isCommentOnlyModification(baseCommit, file)) continue;
    assert.ok(false, `${file} is in a non-add state (${code}). Applied migrations are immutable; create a new NNN_*.sql file instead.`);
  }
}

function checkDestructiveOps(files) {
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    const destructive = [];
    if (/\bDROP\s+TABLE\b/i.test(sql)) destructive.push('DROP TABLE');
    if (/\bDROP\s+COLUMN\b/i.test(sql)) destructive.push('DROP COLUMN');
    if (/\bDROP\s+(INDEX|UNIQUE\s+INDEX)\b/i.test(sql)) destructive.push('DROP INDEX');
    if (/\bRENAME\s+TABLE\b/i.test(sql)) destructive.push('RENAME TABLE');
    if (/\bRENAME\s+COLUMN\b/i.test(sql)) destructive.push('RENAME COLUMN');
    if (/\bDELETE\s+FROM\b/i.test(sql)) destructive.push('DELETE FROM');
    if (destructive.length === 0) continue;
    assert.ok(
      DESTRUCTIVE_ALLOWLIST.has(f),
      `${f}: destructive migration (${destructive.join(', ')}) is blocked by default. ` +
        `A destructive op can break rolling deploys (old Worker + new schema). ` +
        `Verify backward compatibility, then add to DESTRUCTIVE_ALLOWLIST in migrations-check.mjs.`,
    );
  }
}

function run() {
  const files = listMigrations();
  checkMonotonicAndUnique(files);
  checkIdempotent(files);
  checkImmutability(files);
  checkDestructiveOps(files);
  console.log(`migrations:check: ${files.length} files, governance rules enforced.`);
}

try {
  run();
  console.log('migrations governance check: PASSED');
} catch (error) {
  console.error('migrations governance check: FAILED');
  console.error(error?.message || error);
  process.exit(1);
}
