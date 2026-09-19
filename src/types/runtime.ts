// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Shared runtime boundary types. Keep these structural and dependency-light so
// Worker code can type its environment/callback surface without pulling the
// full Cloudflare type package into the DOM-based compilation target.

import type { D1Database } from './cloudflare.ts';

export type GatewayEnv = Record<string, unknown> & {
  TOKEN_STATS_DB?: D1Database,
};

export type ExecutionContextLike = {
  waitUntil?: (promise: Promise<unknown>) => void,
};

export type GatewayLogger = {
  error: (...args: unknown[]) => void,
  info: (...args: unknown[]) => void,
  debug: (...args: unknown[]) => void,
};
