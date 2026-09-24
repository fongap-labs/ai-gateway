#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideDeploy } from '../scripts/deploy-gate-decision.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deploy = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8').replace(/\r\n/g, '\n');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const bridge = readFileSync(join(root, 'scripts/github-deployment-config.mjs'), 'utf8');
const diagnostics = readFileSync(join(root, 'src/observability/diagnostic-endpoints.ts'), 'utf8');

function pos(text) { return deploy.indexOf(text); }
function jobBlock(name) {
  const header = new RegExp(`^  ${name}:\\s*$`, 'm');
  const match = header.exec(deploy);
  assert.ok(match, `${name} job must exist`);
  const start = match.index;
  const tail = deploy.slice(start + match[0].length);
  const next = tail.search(/^  [A-Za-z][\w-]*:\s*$/m);
  return next >= 0 ? deploy.slice(start, start + match[0].length + next) : deploy.slice(start);
}

const migration = pos('- name: Apply D1 migrations');
const workerDeploy = pos('- name: Deploy Worker');
const verify = pos('- name: Verify deployed gateway');
const rollback = pos('- name: Rollback');
assert.ok(migration >= 0 && workerDeploy > migration, 'D1 migrations must run before Worker deploy');
assert.ok(verify > workerDeploy, 'remote verification must run after Worker deploy');
assert.ok(rollback > verify, 'rollback must follow failed post-deploy verification');
assert.match(deploy, /if: failure\(\) && steps\.deploy\.outcome == 'success'/);

assert.match(deploy, /on:\s*\n\s*status:/);
assert.doesNotMatch(deploy, /workflow_run:/);
assert.match(ci, /run-central-ci-ref/);
assert.match(ci, /AW_DISPATCH_TOKEN/);
assert.doesNotMatch(ci, /npm\s+run/);
assert.doesNotMatch(ci, /validate-deploy:/);
assert.doesNotMatch(ci, /validate-merge:/);
assert.match(deploy, /manual-validate:[\s\S]*npm run validate:deploy[\s\S]*npm run check:deploy/);
assert.match(jobBlock('deploy-policy'), /uses: fongap-labs\/action-worker\/\.github\/workflows\/validate-deploy-policy\.yml@main/);
assert.match(jobBlock('deploy-policy'), /target_sha: \$\{\{ github\.event\.sha \|\| github\.sha \}\}/);
assert.match(jobBlock('deploy-policy'), /ci_workflow: ci\.yml/);
assert.match(jobBlock('deploy-policy'), /require_default_head: true/);

const centralRun = 'https://github.com/fongap-labs/action-worker/actions/runs/123';
const sha = 'a'.repeat(40);
const base = {
  event: 'status',
  statusContext: 'CI Evidence',
  statusState: 'success',
  statusTargetUrl: centralRun,
  headSha: sha,
  defaultSha: sha,
  changedFiles: ['src/index.ts'],
};
assert.equal(decideDeploy(base).deploy, true, 'central CI evidence for current main may auto-deploy');
assert.equal(decideDeploy({ ...base, statusContext: 'ci-evidence' }).deploy, false);
assert.equal(decideDeploy({ ...base, statusState: 'failure' }).deploy, false);
assert.equal(decideDeploy({ ...base, statusTargetUrl: 'https://example.invalid/run/123' }).deploy, false);
assert.equal(decideDeploy({ ...base, defaultSha: 'b'.repeat(40) }).deploy, false);
assert.equal(decideDeploy({ ...base, changedFiles: ['README.md', 'docs/README.md'] }).deploy, false);
assert.equal(decideDeploy({ event: 'workflow_dispatch' }).deploy, true);

assert.match(deploy, /vars\.AIG_IS_DEPLOY_ENABLED != 'false'/);
assert.doesNotMatch(deploy, /AIG_DEPLOY_REPOSITORY/);
assert.doesNotMatch(deploy, /github\.repository == 'fongap-labs\/ai-gateway'/);
assert.match(jobBlock('gate'), /ref: \$\{\{ github\.event\.sha \|\| github\.sha \}\}/);
assert.match(jobBlock('deploy'), /ref: \$\{\{ needs\.deploy-policy\.outputs\.target_sha \}\}/);
assert.match(jobBlock('manual-validate'), /ref: \$\{\{ needs\.deploy-policy\.outputs\.target_sha \}\}/);
assert.match(deploy, /DEPLOYED_SHA: \$\{\{ needs\.deploy-policy\.outputs\.target_sha \}\}/);
assert.match(deploy, /health-check --from-env --expected-build "\$DEPLOYED_SHA"/);

assert.match(bridge, /EXTRA_VAR_ALLOW\s*=\s*new Set\(\['GITHUB_SHA', 'AIG_PUBLIC_URL'\]\)/);
assert.ok(bridge.includes('${origin}/health'));
assert.match(bridge, /healthBody\?\.build !== expectedBuild/);
assert.match(diagnostics, /build:\s*resolveBuildSha\(env\)/);

for (const match of deploy.matchAll(/npm\s+run\s+([A-Za-z0-9_:-]+)/g)) {
  assert.ok(Object.hasOwn(pkg.scripts || {}, match[1]), `workflow references missing npm script ${match[1]}`);
}

console.log('deployment-workflow-contract: all contracts passed');
