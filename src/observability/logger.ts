// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { getLimits } from '../config/timeouts.ts';
import type { GatewayEnv, GatewayLogger } from '../types/runtime.ts';

export type { GatewayLogger };

const LEVELS: Record<string, number> = { none: 0, error: 1, warn: 1, info: 2, debug: 3 };

export function getLogger(env: GatewayEnv): GatewayLogger {
  // The documented default stays "info"; AIG_COST_GUARDS switches the default
  // to "warn" (every info line is a console.log call on the isolate's I/O
  // path). An explicitly set AIG_LOG_LEVEL wins on both sides, and any unknown
  // value still falls back to info exactly like before.
  const levelKey = String(env?.AIG_LOG_LEVEL || getLimits(env).logLevelDefault).toLowerCase();
  const level = LEVELS[levelKey] ?? 2;
  return {
    isEnabled: (name: 'info' | 'debug') => level >= (name === 'debug' ? 3 : 2),
    error: (...args: unknown[]) => {
      if (level >= 1) console.error(...args);
    },
    info: (...args: unknown[]) => {
      if (level >= 2) console.log(...args);
    },
    debug: (...args: unknown[]) => {
      if (level >= 3) console.debug(...args);
    },
  };
}

/** Construct hot-path diagnostics only when the configured level emits them.
 * Custom logger mocks without isEnabled still receive the original message.
 */
export function logLazy(logger: GatewayLogger, level: 'info' | 'debug', build: () => string): void {
  if (logger.isEnabled?.(level) === false) return;
  logger[level](build());
}
