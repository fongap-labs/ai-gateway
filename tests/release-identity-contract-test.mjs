#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
assert.equal(Object.hasOwn(pkg, 'version'), false, 'package.json must not own project release numbering');
assert.equal(Object.hasOwn(lock, 'version'), false, 'package-lock root must not own project release numbering');
assert.equal(Object.hasOwn(lock.packages?.[''] || {}, 'version'), false, 'root lock package must not own project release numbering');

for (const rel of [
  'src/config/version.ts',
  'scripts/generate-version.mjs',
  'scripts/version-check.mjs',
  'tests/version-check-test.mjs',
  'docs/governance/version-policy.md',
]) {
  assert.equal(existsSync(join(root, rel)), false, `${rel} must stay deleted`);
}

const router = read('src/request/router.ts');
const diagnostics = read('src/observability/diagnostic-endpoints.ts');
const deploy = read('scripts/github-deployment-config.mjs');
const installSh = read('scripts/install.sh');
const installPs1 = read('scripts/install.ps1');
const toolingReadme = read('scripts/README.md');
const product = read('docs/governance/product-policy.md');

assert.equal(router.includes("'/version'"), false, 'runtime must not expose /version');
assert.equal(diagnostics.includes("../config/version"), false, 'runtime must not import a source version module');
assert.match(diagnostics, /build:\s*resolveBuildSha\(env\)/, '/health must expose commit build identity');
assert.equal(deploy.includes('`${origin}/version`'), false, 'deployment verifier must not use /version');
assert.ok(deploy.includes('`${origin}/health`'), 'deployment verifier must use /health');
assert.match(deploy, /healthBody\?\.build !== expectedBuild/, 'deployment verification must compare commit SHA');
for (const [name, source] of [['POSIX installer', installSh], ['PowerShell installer', installPs1]]) {
  assert.equal(source.includes('/version'), false, `${name} must not probe retired /version`);
  assert.equal(source.includes('scripts/version-check.mjs'), false, `${name} must not call the deleted version-check script`);
  assert.ok(source.includes('/health'), `${name} must verify /health`);
  assert.ok(source.includes('/v1/models'), `${name} must verify /v1/models`);
  assert.ok(source.includes('engines.node'), `${name} must read the Node requirement from package.json`);
}
assert.doesNotMatch(toolingReadme, /version:sync|Version synchronization|version-check\.mjs/i,
  'tooling docs must not restore retired project-version automation');
assert.match(product, /Project release numbering is human-owned only/i);
assert.match(product, /human creates the Git tag or GitHub Release manually/i);

console.log('release identity contract tests passed.');
