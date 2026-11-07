// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Public API request entrypoint. Scheduled maintenance belongs to operations.

import { sanitizedInternalErrorForRoute } from '../../src/observability/diagnostic-endpoints.ts';
import { gatewayStats, isCountedRoute, trackClientResponse } from '../../src/observability/gateway-stats.ts';
import { detectRoute, normalizePath } from '../../src/request/router.ts';
import type { ExecutionContextLike, GatewayEnv } from '../../src/types/runtime.ts';
import { handleRequest } from './request-handler.ts';

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
};
