#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Enforce dependency direction incrementally: packages are neutral; apps may
// depend on packages; cross-app source imports are always forbidden.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
function walk(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((name) => {
    const target = join(folder, name);
    return statSync(target).isDirectory() ? walk(target) : target.endsWith('.ts') ? [target] : [];
  });
}
let checked = 0;
for (const file of [...walk(join(root, 'packages')), ...walk(join(root, 'apps'))]) {
  const local = relative(root, file).replaceAll('\\', '/');
  const imports = [...readFileSync(file, 'utf8').matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)];
  for (const [, specifier] of imports) {
    if (!specifier?.startsWith('.')) continue;
    const target = relative(root, resolve(file, '..', specifier)).replaceAll('\\', '/');
    if (local.startsWith('packages/')) {
      assert.ok(!target.startsWith('src/') && !target.startsWith('apps/'), `${local} imports implementation: ${target}`);
    }
    if (local.startsWith('apps/')) {
      const ownApp = local.split('/')[1];
      assert.ok(!target.startsWith('apps/') || target.startsWith(`apps/${ownApp}/`), `${local} imports another app: ${target}`);
    }
  }
  checked++;
}
assert.ok(checked >= 4, 'Missing independently owned app entrypoints or contracts');
for (const [app, shim] of [
  ['apps/gateway/index.ts', 'src/index.ts'],
  ['apps/inference/index.ts', 'src/inference/inference-center-entry.ts'],
  ['apps/generation/index.ts', 'src/generation/generation-center-entry.ts'],
]) {
  assert.ok(existsSync(join(root, app)), `Missing running app: ${app}`);
  assert.match(readFileSync(join(root, shim), 'utf8'), /apps\//, `Compatibility entrypoint not delegated: ${shim}`);
}
for (const path of [
  'apps/inference/index.ts',
  'apps/generation/index.ts',
  'src/inference/inference-client-request.ts',
  'src/generation/generation-client-request.ts',
]) {
  const content = readFileSync(join(root, path), 'utf8');
  assert.match(content, /packages\/contracts\/execution\.ts/, `${path} does not use the contract`);
}
console.log(`Architecture boundary check passed (${checked} package/app files).`);
