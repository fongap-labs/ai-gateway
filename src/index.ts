// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Worker entrypoint: request accounting, top-level error handling, and scheduled usage maintenance.

import { handleRequest } from './request/handler.ts';
import { isCountedRoute, gatewayStats, trackClientResponse } from './observability/gateway-stats.ts';
import { normalizePath, detectRoute } from './request/router.ts';
import { sanitizedInternalErrorForRoute } from './observability/diagnostic-endpoints.ts';
import { maintainUsageStats } from './observability/token-usage-store.ts';
import type { ExecutionContextLike, GatewayEnv } from './types/runtime.ts';

export default {
  async fetch(request: Request, env: GatewayEnv, ctx: ExecutionContextLike): Promise<Response> {
    const pathname = normalizePath(new URL(request.url).pathname);
    const route = detectRoute(request.method.toUpperCase(), pathname);
    const counted = isCountedRoute(request.method.toUpperCase(), pathname);
    if (counted) {
      gatewayStats.requests++;
      gatewayStats.activeRequests++;
    }
    try {
      const response = await handleRequest(request, env, ctx);
      return counted ? trackClientResponse(response) : response;
    } catch (error) {
      if (counted) {
        gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
        gatewayStats.failures++;
        if (request.signal?.aborted) gatewayStats.cancellations++;
      }
      console.error('unhandled gateway error:', (error as Error)?.message || error);
      return sanitizedInternalErrorForRoute(request, env, route, crypto.randomUUID().slice(0, 8));
    }
  },

  // Periodic token-usage aggregation and retention maintenance.
  async scheduled(_controller: unknown, env: GatewayEnv, _ctx: ExecutionContextLike): Promise<void> {
    await maintainUsageStats(env);
  },
};
