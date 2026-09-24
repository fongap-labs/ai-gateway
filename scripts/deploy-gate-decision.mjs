#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CONTROL_RUN_PREFIX = 'https://github.com/fongap-labs/action-worker/actions/runs/';

/**
 * @param {{
 *   event: string,
 *   statusContext?: string,
 *   statusState?: string,
 *   statusTargetUrl?: string,
 *   headSha?: string,
 *   defaultSha?: string,
 *   changedFiles?: string[] | null,
 * }} inputs
 * @returns {{ deploy: boolean, reason: string }}
 */
export function decideDeploy({
  event,
  statusContext = '',
  statusState = '',
  statusTargetUrl = '',
  headSha = '',
  defaultSha = '',
  changedFiles = null,
}) {
  if (event === 'workflow_dispatch') {
    return { deploy: true, reason: 'manual workflow_dispatch — full validation runs in the manual-validate job' };
  }
  if (event !== 'status') {
    return { deploy: false, reason: `unsupported deploy trigger '${event || 'unknown'}'` };
  }
  if (statusContext !== 'CI Evidence') {
    return { deploy: false, reason: `status context '${statusContext || 'unknown'}' is not deploy evidence` };
  }
  if (statusState !== 'success') {
    return { deploy: false, reason: `CI Evidence state is '${statusState || 'unknown'}' — deploy blocked` };
  }
  if (!statusTargetUrl.startsWith(CONTROL_RUN_PREFIX)) {
    return { deploy: false, reason: 'CI Evidence was not produced by the Action Worker control plane' };
  }
  if (!/^[0-9a-f]{40}$/.test(headSha) || headSha !== defaultSha) {
    return { deploy: false, reason: 'CI Evidence does not belong to the current default-branch HEAD' };
  }
  if (changedFiles !== null) {
    if (changedFiles.length === 0) {
      return { deploy: false, reason: 'no deployable file changes — deploy skipped' };
    }
    const deployable = changedFiles.filter((f) => !/\.md$/.test(f) && !/^docs\//.test(f));
    if (deployable.length === 0) {
      return { deploy: false, reason: 'triggering commit changed only markdown/docs paths — deploy skipped' };
    }
  }
  return { deploy: true, reason: 'default-branch HEAD passed Action Worker Central CI — deploy allowed' };
}

function isDirectRun() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const env = process.env;
  const event = env.EVENT || '';
  const statusContext = env.STATUS_CONTEXT || '';
  const statusState = env.STATUS_STATE || '';
  const statusTargetUrl = env.STATUS_TARGET_URL || '';
  const headSha = env.HEAD_SHA || '';
  const defaultSha = env.DEFAULT_SHA || '';

  let changedFiles = null;
  if (
    event === 'status'
    && statusContext === 'CI Evidence'
    && statusState === 'success'
    && statusTargetUrl.startsWith(CONTROL_RUN_PREFIX)
    && headSha === defaultSha
  ) {
    try {
      execFileSync(
        'git',
        ['config', '--global', '--add', 'safe.directory', env.GITHUB_WORKSPACE || process.cwd()],
        { stdio: 'ignore' },
      );
      const out = execFileSync('git', ['diff', '--name-only', `${headSha}^`, headSha], { encoding: 'utf8' });
      changedFiles = out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      changedFiles = null;
    }
  }

  const decision = decideDeploy({
    event,
    statusContext,
    statusState,
    statusTargetUrl,
    headSha,
    defaultSha,
    changedFiles,
  });
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `deploy=${decision.deploy}\n`);
  }
  console.log(decision.deploy ? decision.reason : `::notice::${decision.reason}`);
}
