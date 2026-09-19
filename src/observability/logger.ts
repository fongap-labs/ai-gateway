// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

const LEVELS: Record<string, number> = { none: 0, error: 1, info: 2, debug: 3 };

import type { GatewayEnv, GatewayLogger } from '../types/runtime.ts';

export type { GatewayLogger };

export function getLogger(env: GatewayEnv): GatewayLogger {
  const levelKey = String(env?.LOG_LEVEL || 'info').toLowerCase();
  const level = LEVELS[levelKey] ?? 2;
  return {
    error: (...args: unknown[]) => { if (level >= 1) console.error(...args); },
    info: (...args: unknown[]) => { if (level >= 2) console.log(...args); },
    debug: (...args: unknown[]) => { if (level >= 3) console.debug(...args); },
  };
}
