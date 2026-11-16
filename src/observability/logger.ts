import { getLimits } from '../config/timeouts.ts';
import type { GatewayEnv, GatewayLogger } from '../types/runtime.ts';

export type { GatewayLogger };

const LEVELS: Record<string, number> = { none: 0, error: 1, warn: 1, info: 2, debug: 3 };

export function getLogger(env: GatewayEnv): GatewayLogger {
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

export function logLazy(logger: GatewayLogger, level: 'info' | 'debug', build: () => string): void {
  if (logger.isEnabled?.(level) === false) return;
  logger[level](build());
}
