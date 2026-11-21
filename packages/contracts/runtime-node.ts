import type { Protocol, Surface } from './protocol.ts';

export type NodeTier = 'tier-1' | 'tier-2';

export type NodeModelMap = { [logicalModel: string]: string };

export type NodeReasoning = {
  mode: 'none' | 'effort' | 'adaptive' | 'budget';
  efforts?: ReadonlyArray<'low' | 'medium' | 'high' | 'max'>;
  highBudgetTokens?: number;
};

export type RuntimeNode = {
  id: string;
  keyGroup?: string;
  credentialIdentity?: string;
  tier: NodeTier;
  provider: string;
  protocol: Protocol;
  surfaces: ReadonlyArray<Surface>;
  baseUrl: string;
  credential: string;
  priority: number;
  models: NodeModelMap;
  reasoning?: NodeReasoning;
};
