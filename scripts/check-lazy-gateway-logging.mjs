#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Disabled log levels must skip expensive per-attempt message construction.
// Keep existing console output and custom Logger mocks unchanged.
import assert from 'node:assert/strict';
import { getLogger, logLazy } from '../src/observability/logger.ts';

const output = [];
const originals = { log: console.log, debug: console.debug, error: console.error };
console.log = (...args) => output.push(['info', ...args]);
console.debug = (...args) => output.push(['debug', ...args]);
console.error = (...args) => output.push(['error', ...args]);
try {
  let formatted = 0;
  const build = () => {
    formatted++;
    return 'dispatch request=test node=slow-provider';
  };

  const disabled = getLogger({ AIG_LOG_LEVEL: 'none' });
  assert.equal(disabled.isEnabled?.('info'), false);
  assert.equal(disabled.isEnabled?.('debug'), false);
  logLazy(disabled, 'info', build);
  logLazy(disabled, 'debug', build);
  assert.equal(formatted, 0, 'disabled diagnostic levels must not allocate a message');
  assert.equal(output.length, 0);

  const costGuarded = getLogger({ AIG_COST_GUARDS: 'true' });
  assert.equal(costGuarded.isEnabled?.('info'), false, 'cost guards disable info by default');
  logLazy(costGuarded, 'info', build);
  logLazy(costGuarded, 'debug', build);
  assert.equal(formatted, 0, 'cost-guarded hot path must remain lazy');

  const normal = getLogger({});
  assert.equal(normal.isEnabled?.('info'), true, 'default info behavior is unchanged');
  assert.equal(normal.isEnabled?.('debug'), false);
  logLazy(normal, 'debug', build);
  logLazy(normal, 'info', build);
  assert.equal(formatted, 1);
  assert.deepEqual(output, [['info', 'dispatch request=test node=slow-provider']]);

  const verbose = getLogger({ AIG_LOG_LEVEL: 'debug' });
  assert.equal(verbose.isEnabled?.('debug'), true);
  logLazy(verbose, 'debug', build);
  assert.equal(formatted, 2);
  assert.deepEqual(output.at(-1), ['debug', 'dispatch request=test node=slow-provider']);

  const errorsOnly = getLogger({ AIG_LOG_LEVEL: 'error' });
  logLazy(errorsOnly, 'info', build);
  errorsOnly.error('genuine provider failure');
  assert.equal(formatted, 2);
  assert.deepEqual(output.at(-1), ['error', 'genuine provider failure'], 'error messages remain visible');

  const customRecords = [];
  const custom = {
    error: (...args) => customRecords.push(['error', ...args]),
    info: (...args) => customRecords.push(['info', ...args]),
    debug: (...args) => customRecords.push(['debug', ...args]),
  };
  logLazy(custom, 'debug', build);
  logLazy(custom, 'info', build);
  assert.equal(formatted, 4, 'old Logger mocks without level probes retain messages');
  assert.deepEqual(customRecords, [
    ['debug', 'dispatch request=test node=slow-provider'],
    ['info', 'dispatch request=test node=slow-provider'],
  ]);

  logLazy(disabled, 'debug', () => {
    throw new Error('this disabled log message must not be formatted');
  });
} finally {
  console.log = originals.log;
  console.debug = originals.debug;
  console.error = originals.error;
}
console.log('Lazy Gateway diagnostics preserve levels, failure visibility and legacy Logger mocks.');
