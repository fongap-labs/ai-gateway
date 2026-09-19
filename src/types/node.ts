// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Runtime Node shape produced by the config layer. Canonical type consumed
// by the scheduler, reliability, and request layers (src/types/domain.d.ts
// has been deleted — see docs/governance/typescript-migration.md).

import type { Protocol, Surface } from './protocol.ts';

/** The node-level tier label used by the config layer and reliability state
 * (distinct from the numeric policy Tier). */
export type NodeTier = 'tier-1' | 'tier-2' | 'tier-3';

/**
 *   empty object {} means a catalog-bounded wildcard: the node may serve only
 *   logical models present in the Known Model Catalog supplied by callers.
 *   Without that catalog, wildcard matching fails closed.
 *   A non-empty map binds the gateway's logical model to the upstream model.
 */
export type NodeModelMap = { [logicalModel: string]: string };

export type RuntimeNode = {
  id: string,
  tier: NodeTier,
  provider: string,
  protocol: Protocol,
  surfaces: ReadonlyArray<Surface>,
  baseUrl: string,
  credential: string,
  priority: number,
  models: NodeModelMap,
};
