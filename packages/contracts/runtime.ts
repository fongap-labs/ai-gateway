import type { D1Database } from './cloudflare.ts';

export type GatewayEnv = Record<string, unknown> & {
  TOKEN_STATS_DB?: D1Database;
};

export type GatewayTraceSpan = {
  setAttribute: (key: string, value: string | number | boolean) => void;
  isTraced?: boolean;
};

export type ExecutionContextLike = {
  waitUntil?: (promise: Promise<unknown>) => void;
  tracing?: {
    enterSpan: <T>(name: string, callback: (span: GatewayTraceSpan) => T | Promise<T>) => T | Promise<T>;
  };
};

export type GatewayLogger = {
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  isEnabled?: (level: 'info' | 'debug') => boolean;
};
