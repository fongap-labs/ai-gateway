// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { Protocol, Surface } from './protocol.ts';
import type { RuntimeNode } from './runtime-node.ts';

export type Tier = 1 | 2;

export type TierMap<T> = Record<Tier, T>;

export type RoutableRequest = {
  model: string;
  protocol: Protocol;
  surface: Surface;
  bodyChars?: number;
};

export type PickedCandidate = {
  node?: RuntimeNode;
  raceLost?: boolean;
  raceLostNodeId?: string;
  releaseToken?: { accountId: string; modelId: string | null; released: boolean; settled: boolean; quotaReserved: number } | null;
  updateAffinity?: boolean;
  escapedFromAffinity?: boolean;
  affinityHit?: boolean;
};
