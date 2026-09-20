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
assert.match(deploy, /if: failure\(\) && steps\.deploy\.outcome == 'success'/,
  'rollback must require a completed deploy followed by failure');

assert.match(deploy, /workflow_run:[\s\S]*workflows: \[CI\][\s\S]*branches: \[main\]/);
assert.match(ci, /validate-merge:/);
assert.match(ci, /validate-deploy:/);
assert.match(ci, /npm run validate:deploy/);
assert.ok(!ci.includes('cleanup-legacy-workflow-history'), 'one-shot cleanup job must not remain in permanent CI');
assert.ok(!ci.includes('actions: write'), 'permanent CI must not retain Actions write permission');
assert.match(deploy, /manual-validate:[\s\S]*npm run validate:deploy[\s\S]*npm run check:deploy/);
assert.match(jobBlock('deploy-policy'), /uses: fongap-labs\/action-worker\/\.github\/workflows\/validate-deploy-policy\.yml@main/);
assert.match(jobBlock('deploy-policy'), /target_sha: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
assert.match(jobBlock('deploy-policy'), /ci_workflow: ci\.yml/);
assert.match(jobBlock('deploy-policy'), /require_default_head: true/);
assert.match(jobBlock('manual-validate'), /needs:[\s\S]*- gate[\s\S]*- deploy-policy/);
assert.match(jobBlock('deploy'), /needs:[\s\S]*- gate[\s\S]*- deploy-policy[\s\S]*- manual-validate/);

const base = {
  event: 'workflow_run',
  ciConclusion: 'success',
  headRepo: 'fongap-labs/ai-gateway',
  thisRepo: 'fongap-labs/ai-gateway',
  changedFiles: ['src/index.ts'],
};
assert.equal(decideDeploy({ ...base, triggerEvent: 'push' }).deploy, true, 'successful push CI may auto-deploy');
assert.equal(decideDeploy({ ...base, triggerEvent: 'schedule' }).deploy, false, 'scheduled CI is test-only');
assert.equal(decideDeploy({ ...base, triggerEvent: 'workflow_dispatch' }).deploy, false, 'manual CI is test-only');
assert.equal(decideDeploy({ ...base, triggerEvent: 'push', ciConclusion: 'failure' }).deploy, false, 'failed CI must block deploy');
assert.equal(decideDeploy({ ...base, triggerEvent: 'push', headRepo: 'someone/ai-gateway' }).deploy, false, 'fork head must not auto-deploy');
assert.equal(decideDeploy({ ...base, triggerEvent: 'push', changedFiles: ['README.md', 'docs/README.md'] }).deploy, false, 'docs-only change must skip deploy');
assert.equal(decideDeploy({ event: 'workflow_dispatch' }).deploy, true, 'manual Deploy workflow may enter its own validation gate');

assert.match(deploy, /vars\.IS_DEPLOY_ENABLED == 'true'/);
assert.match(deploy, /github\.repository == vars\.DEPLOY_REPOSITORY/);
assert.doesNotMatch(deploy, /github\.repository == 'fongap-labs\/ai-gateway'/);
assert.doesNotMatch(deploy, /github\.repository == 'fongap\/ai-gateway'/);

const eventTargetRef = /ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/;
const governedTargetRef = /ref: \$\{\{ needs\.deploy-policy\.outputs\.target_sha \}\}/;
assert.match(jobBlock('gate'), eventTargetRef, 'pre-policy gate checkout must inspect the triggering commit');
assert.match(jobBlock('deploy'), governedTargetRef, 'deploy checkout must use the centrally validated commit');
assert.match(jobBlock('manual-validate'), governedTargetRef,
  'manual validation checkout must use the centrally validated commit');
assert.equal((deploy.match(/uses: actions\/checkout@/g) || []).length, 3,
  'deploy workflow keeps exactly one checkout per job');
assert.ok(!deploy.includes('Checkout triggering commit'));
assert.ok(!deploy.includes('Checkout (manual dispatch)'));
assert.match(deploy, /DEPLOYED_SHA: \$\{\{ needs\.deploy-policy\.outputs\.target_sha \}\}/);
assert.match(deploy, /GITHUB_SHA: \$\{\{ needs\.deploy-policy\.outputs\.target_sha \}\}/);
assert.match(deploy, /health-check --from-env --expected-build "\$DEPLOYED_SHA"/);
assert.match(deploy, /Deployed SHA/);

assert.match(bridge, /EXTRA_VAR_ALLOW\s*=\s*new Set\(\['GITHUB_SHA'\]\)/);
assert.ok(bridge.includes('`${origin}/health`'), 'remote verifier must call /health');
assert.equal(bridge.includes('`${origin}/version`'), false, 'remote verifier must not call /version');
assert.match(bridge, /healthBody\?\.build !== expectedBuild/);
assert.match(diagnostics, /build:\s*resolveBuildSha\(env\)/);
assert.equal(diagnostics.includes('versionResponse'), false);

for (const wf of [deploy, ci]) {
  for (const match of wf.matchAll(/npm\s+run\s+([A-Za-z0-9_:-]+)/g)) {
    assert.ok(Object.hasOwn(pkg.scripts || {}, match[1]), `workflow references missing npm script ${match[1]}`);
  }
}

console.log('deployment-workflow-contract: all contracts passed');
