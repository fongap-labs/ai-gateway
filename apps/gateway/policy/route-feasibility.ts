// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { GatewayEnv } from '../../../packages/contracts/runtime.ts';
import { getFallbackChain } from '../../../src/config/protocol-fallbacks.ts';
import { supportsRequest } from '../../../src/scheduler/scheduler.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';
import type { Protocol, Surface } from '../../../src/types/protocol.ts';
import type { RequestDescriptor, RouteFeasibilityResult } from '../../../src/types/request.ts';
import type { TierMap } from '../../../src/types/scheduler.ts';
import { TIER_ORDER } from './router.ts';

export function evaluateRouteFeasibility({
  route,
  requestedModel,
  requestDescriptor,
  tiers,
  knownModels,
  env,
}: {
  route: string;
  requestedModel: string;
  requestDescriptor: RequestDescriptor;
  tiers: TierMap<RuntimeNode[]>;
  knownModels: Set<string>;
  env: GatewayEnv;
}): RouteFeasibilityResult {
  const nativeSupported = TIER_ORDER.some((t) => tiers[t].some((n) => supportsRequest(n, requestDescriptor, knownModels)));

  const fallbacks: Array<{ protocol: Protocol; surface: Surface }> = [];
  for (const fb of getFallbackChain(route, env)) {
    const fbReqDescriptor = { model: requestedModel, protocol: fb.protocol, surface: fb.surface };
    if (TIER_ORDER.some((t) => tiers[t].some((n) => supportsRequest(n, fbReqDescriptor, knownModels)))) {
      fallbacks.push({ protocol: fb.protocol, surface: fb.surface });
    }
  }

  return {
    reachable: nativeSupported || fallbacks.length > 0,
    nativeSupported,
    fallbackSupported: fallbacks.length > 0,
    fallbacks,
  };
}
