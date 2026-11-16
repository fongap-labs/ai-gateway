// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { Limits } from '../config/timeouts.ts';
import type { FailureKind } from '../reliability/classify.ts';
import type { RetrySlot } from '../reliability/retry-budget.ts';
import type { EdgeCachePlan } from '../request/edge-cache.ts';
import type { RuntimeNode } from './node.ts';
import type { PolicyConfig } from './policy.ts';
import type { Protocol, Surface } from './protocol.ts';
import type { ExecutionContextLike, GatewayEnv, GatewayLogger } from './runtime.ts';
import type { RoutableRequest, Tier, TierMap } from './scheduler.ts';

export type RequestDescriptor = {
  route: 'openai_chat' | 'openai_responses' | 'anthropic_messages' | 'anthropic_count_tokens' | 'openai_images';
  model: string;
  protocol: Protocol;
  surface: Surface;
  bodyChars?: number;
};

export type RawBody = { text: string };

export type AuthResult =
  | { authorized: false; mode: 'none' | 'grouped' }
  | { authorized: true; mode: 'grouped'; group: string; allowAll: boolean; allowlist: Set<string> | undefined }
  | { authorized: true; mode: 'skip'; group: null };

export type RouteFeasibilityResult = {
  reachable: boolean;
  nativeSupported: boolean;
  fallbackSupported: boolean;
  fallbacks: ReadonlyArray<{ protocol: Protocol; surface: Surface }>;
};

export type ConversionContext = {
  fallbackProtocol: Protocol;
  fallbackSurface: Surface;
  convertedBody: Record<string, unknown>;
  clientRoute: string;
  isNonstreamPreferred: boolean;
};

export type LoopState = {
  attempted: Set<string>;
  attempts: Array<Record<string, unknown>>;
  logicalAttempts: number;
  dispatches: number;
  hedges: number;
  failureKinds: Partial<Record<FailureKind, number>>;
  conversionRejections?: number;
  tierAttemptsUsed?: Record<number, number>;
  retrySlot?: RetrySlot;
  retryShed?: boolean;
  logger: GatewayLogger;
  requestId: string;
  maxAttempts: number;
  maxDispatches: number;
  requestedModel: string;
  nodes: ReadonlyArray<RuntimeNode>;
  knownModels?: ReadonlySet<string>;
};

export type LoopContext = {
  request: Request;
  env: GatewayEnv;
  ctx: ExecutionContextLike;
  logger: GatewayLogger;
  requestId: string;
  route: string;
  requestedModel: string;
  clientWantsStream: boolean;
  fakeStream: boolean;
  bodyJson: Record<string, unknown>;
  rawBody?: RawBody;
  imageInputRequired?: boolean;
  bodyChars?: number;
  limits: Limits;
  exposeUpstreamInfo: boolean;
  state: LoopState;
  failoverBudgetMs: number;
  requestStartMs: number;
  policy: PolicyConfig;
  tiers: TierMap<RuntimeNode[]>;
  tier1Affinity: string | null;
  tier1EvaluateAffinity: boolean;
  tier1Rng: () => number;
  tier1Session: string | null;
  knownModels: Set<string>;
  feasibility: RouteFeasibilityResult;
  edgeCachePlan: EdgeCachePlan | null;
  futureAttemptReserve: number;
  attemptCapMs?: number | null;
  takeRemainingWindow?: boolean;
};

export type AttemptSettlement = {
  observedUsage: unknown;
  settled: boolean;
};

export type AttemptContext = {
  request: Request;
  env: GatewayEnv;
  ctx: ExecutionContextLike;
  logger: GatewayLogger;
  requestId: string;
  traceparent?: string;
  route: string;
  node: RuntimeNode;
  requestedModel: string;
  clientWantsStream: boolean;
  fakeStream: boolean;
  bodyJson: Record<string, unknown>;
  rawBody?: RawBody;
  imageInputRequired?: boolean;
  limits: Limits;
  exposeUpstreamInfo: boolean;
  state: LoopState;
  failoverBudgetMs: number;
  requestStartMs: number;
  remainingDispatchableAttempts: number;
  attemptCapMs?: number | null;
  takeRemainingWindow?: boolean;
  reqDescriptor: RoutableRequest;
  policy: PolicyConfig;
  tierNumber: Tier;
  conversionContext: ConversionContext | null;
  tier1ReleaseToken: { accountId: string; modelId: string | null; released: boolean; settled: boolean; quotaReserved: number } | null;
  tier1EscapedFromAffinity: boolean;
  tier1UpdateAffinity: boolean;
  tier1AffinityAccountId: string | null;
  tier1EvaluateAffinity: boolean;
  tier1Session: string | null;
  rng: (() => number) | null;
  hedgedAttempt?: boolean;
  hedgedWithTwin?: boolean;
  hedgeAbort?: AbortController | null;
  attemptDeadlineMs?: number;
  attemptStartMs?: number;
  headersMs?: number;
  upstreamStatus?: number;
  ttftMs?: number;
  upstreamProtocol?: Protocol;
  surface?: Surface;
  attemptSettlement?: AttemptSettlement;
};

export type AttemptOutcome = {
  response?: Response;
  rotate?: boolean;
  stop?: boolean;
  budgetCharged?: boolean;
  kind?: FailureKind;
  hedgedAway?: boolean;
};
