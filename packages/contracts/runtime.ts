// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Shared runtime boundary types. Keep these structural and dependency-light so
// Worker code can type its environment/callback surface without pulling the
// full Cloudflare type package into the DOM-based compilation target.

import type { D1Database } from './cloudflare.ts';

export type GatewayEnv = Record<string, unknown> & {
  TOKEN_STATS_DB?: D1Database;
};

/** The optional native Cloudflare tracing surface; no runtime import needed. */
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
};
