// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { Protocol, Surface } from './protocol.ts';

export type NodeTier = 'tier-1' | 'tier-2';

export type NodeModelMap = { [logicalModel: string]: string };

export type RuntimeNode = {
  id: string;
  keyGroup?: string;
  tier: NodeTier;
  provider: string;
  protocol: Protocol;
  surfaces: ReadonlyArray<Surface>;
  baseUrl: string;
  credential: string;
  priority: number;
  models: NodeModelMap;
};
