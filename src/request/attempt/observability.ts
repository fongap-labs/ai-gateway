// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Part of src/request/attempt.ts (behavior-preserving split); see
// attempt/index.ts for the module map.

// observability.ts - post-outcome recording for one physical upstream attempt.
// Delivered-response token statistics and physical-attempt token statistics are
// intentionally separate: failed/fallback/hedge work must never fabricate
// successful model-status evidence, but it still belongs in upstream cost
// accounting when usage is reported.

import { gatewayStats, recordStreamCompleted, recordStreamInterrupted, recordStreamStart } from '../../observability/gateway-stats.ts';
import { mergeReportedUsage, normalizeTokenUsage, recordTokenUsage } from '../../observability/token-usage.ts';
import { persistTokenUsage, persistUpstreamAttemptUsage } from '../../observability/token-usage-store.ts';
import { clearAdaptive429State } from '../../reliability/adaptive-429.ts';
import { classifyStreamInterrupted } from '../../reliability/classify.ts';
import { applyHealthPenalty, bumpNodeCounters, recordFailure, recordNeutralEnd, recordSuccess } from '../../reliability/node-state.ts';
import { recordTier1ProviderModelSuccess } from '../../reliability/tier1-heat.ts';
import {
  applyTier1Outcome,
  classifyTier1Failure,
  getTier1Account,
  getTier1ModelPerf,
  recordTier1Success,
  recordTier1Ttft,
  recordTier1UpstreamModelServed,
  releaseTier1Slot,
  settleTier1Quota,
  wakeTier1ProviderSiblings,
} from '../../reliability/tier1-state.ts';
import { writeTier1Affinity } from '../../scheduler/tier1-affinity.ts';
import type { RuntimeNode } from '../../types/node.ts';
import type { AttemptContext, AttemptSettlement } from '../../types/request.ts';
import { upstreamModelOf } from '../response-helpers.ts';
import { releaseLargeRequestBody } from './body-release.ts';

// One settlement holder per physical upstream dispatch. The holder travels by
// reference with the attempt context, so a context copy (a model-family
// fallback rewrites the node) still settles the SAME attempt exactly once
// instead of persisting a second physical attempt for one dispatch.
function settlementOf(c: AttemptContext): AttemptSettlement {
  if (!c.attemptSettlement) c.attemptSettlement = { observedUsage: null, settled: false };
  return c.attemptSettlement;
}

function logicalModelOf(c: AttemptContext): string {
  return c.state?.requestedModel ?? c.requestedModel;
}

function ensureDeliveredTtft(c: AttemptContext): void {
  if (c.ttftMs != null) return;
  const startedAt = c.attemptStartMs;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return;
  c.ttftMs = Math.max(0, Date.now() - startedAt);
}

export function observeUpstreamAttemptUsage(c: AttemptContext, usage: unknown): void {
  if (!c || usage == null) return;
  const settlement = settlementOf(c);
  if (settlement.settled) return;
  const merged = mergeReportedUsage(settlement.observedUsage, usage);
  if (normalizeTokenUsage(merged)) settlement.observedUsage = merged;
}

export function recordTier1NonStreamTtft(c: AttemptContext, node: RuntimeNode, data: unknown, isMeaningful: (data: unknown) => boolean): void {
  if (node.tier !== 'tier-1' || !isMeaningful(data)) return;
  c.ttftMs = Date.now() - (c.attemptStartMs ?? Date.now());
  recordTier1Ttft(node.id, c.state.requestedModel, c.ttftMs);
}

export function recordTokens(c: AttemptContext, node: RuntimeNode, usage: unknown): void {
  const settlement = settlementOf(c);
  if (settlement.settled) return;
  observeUpstreamAttemptUsage(c, usage);
  const reportedUsage = settlement.observedUsage ?? usage;
  settlement.settled = true;
  ensureDeliveredTtft(c);
  const logicalModel = logicalModelOf(c);
  recordTokenUsage({ model: logicalModel, tier: node.tier, provider: node.provider, nodeId: node.id, usage: reportedUsage });
  scheduleD1TokenPersist(c, reportedUsage, logicalModel);
}

export function recordUndeliveredUpstreamAttempt(c: AttemptContext, node: RuntimeNode, usage?: unknown): void {
  const settlement = settlementOf(c);
  if (settlement.settled) return;
  if (usage !== undefined) observeUpstreamAttemptUsage(c, usage);
  settlement.settled = true;
  const observed = settlement.observedUsage ?? null;
  const logicalModel = logicalModelOf(c);
  const task = persistUpstreamAttemptUsage(c.env, observed, Date.now(), logicalModel).catch((err) => {
    const scope = String(err?.scope || '').includes('model') ? 'upstream-model' : 'upstream-global';
    try {
      c.logger?.error?.(`upstream token-stats D1 ${scope} persist failed: ${err?.message || err}`);
    } catch {
      /* fail-open */
    }
  });
  scheduleBackground(c, task);
}

function scheduleD1TokenPersist(c: AttemptContext, usage: unknown, logicalModel?: string): void {
  const modelForPersist = logicalModel ?? logicalModelOf(c);
  const task = persistTokenUsage(c.env, usage, Date.now(), modelForPersist, c.ttftMs ?? null).catch((err) => {
    const scope = err?.scope === 'per-model' ? 'per-model' : 'global';
    try {
      c.logger?.error?.(`token-stats D1 ${scope} persist failed: ${err?.message || err}`);
    } catch {
      /* never throw */
    }
  });
  scheduleBackground(c, task);
}

function scheduleBackground(c: AttemptContext, task: Promise<unknown>): void {
  const ctx = c.ctx;
  if (ctx && typeof ctx.waitUntil === 'function') {
    try {
      ctx.waitUntil(task);
    } catch {
      task.catch(() => {});
    }
  } else {
    task.catch(() => {});
  }
}

/**
 * A committed stream whose matrix translation hit the AIG_CONVERSION_BUDGET
 * ends as a NEUTRAL end with a budget reason, not as a node failure: the reply
 * size is the client's demand, so the key takes no cooldown and the attempt is
 * not counted as delivered, but the physical upstream attempt — which DID run
 * and bill its tokens — is settled exactly once through the undelivered writer.
 * The client saw the protocol error frames / truncated reply through the relay.
 * Composes with the makeNodeStreamTrack callbacks, which the caller bypasses
 * when the budget fired.
 */
export function recordNodeBudgetStop(c: AttemptContext, node: RuntimeNode, reason: string, status: number): void {
  const latencyMs = c.attemptStartMs ? Date.now() - c.attemptStartMs : -1;
  recordUndeliveredUpstreamAttempt(c, node);
  if (node.tier === 'tier-1') {
    const observed = settlementOf(c).observedUsage;
    const consumed = normalizeTokenUsage(observed)?.total ?? 0;
    settleTier1Quota(node.id, c.tier1ReleaseToken, consumed);
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
  } else {
    recordNeutralEnd(node.id);
  }
  bumpNodeCounters(node.id, { requests: 1 });
  gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
  gatewayStats.cancellations++;
  c.logger.info(
    `[conversion-budget] request=${c.requestId} node=${node.id} provider=${node.provider}` +
      ` protocol=${c.upstreamProtocol ?? node.protocol} surface=${c.surface ?? node.surfaces?.[0] ?? ''}` +
      ` tier=${node.tier} model=${logicalModelOf(c)} reason=${reason} status=${status}` +
      ` kind=client code=conversion_budget_exceeded counted=false latency_ms=${latencyMs}`,
  );
}

export function recordNodeSuccess(c: AttemptContext, node: RuntimeNode, latencyMs: number): void {
  if (node.tier === 'tier-1') {
    const logicalModel = c.state.requestedModel;
    const rateLimited = () =>
      getTier1Account(node.id).consecutiveRateLimits > 0 || (getTier1ModelPerf(node.id, logicalModel)?.consecutiveRateLimits ?? 0) > 0;
    const wasRateLimited = rateLimited();
    recordTier1Success(node.id, logicalModel);
    if (wasRateLimited && !rateLimited()) {
      const woken = wakeTier1ProviderSiblings(node.provider, node.id, logicalModel);
      if (woken.length) c.state.logger.info(`rate-limit recovery: node=${node.id} provider=${node.provider} woke_siblings=${woken.join(',')}`);
    }
    if (getTier1Account(node.id).consecutiveRateLimits === 0) clearAdaptive429State(node.provider, node.id);
    if (getTier1ModelPerf(node.id, logicalModel)?.consecutiveRateLimits === 0) clearAdaptive429State(node.provider, node.id, logicalModel);
    recordTier1ProviderModelSuccess(node.provider, upstreamModelOf(node, logicalModel), node.id);
    recordTier1UpstreamModelServed(node.id, upstreamModelOf(node, logicalModel));
    // Confirm the quota lease with actual delivered usage before release; a
    // settled lease is not restored, so the request reservation is consumed.
    const observed = settlementOf(c).observedUsage;
    const consumed = normalizeTokenUsage(observed)?.total ?? 0;
    settleTier1Quota(node.id, c.tier1ReleaseToken, consumed);
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    bumpNodeCounters(node.id, { requests: 1, successes: 1 });
    if (c.tier1UpdateAffinity && c.tier1Session) writeTier1Affinity(c.env, c.ctx, c.tier1Session, node.id);
    return;
  }
  recordSuccess(node.id, latencyMs, c.state?.requestedModel);
}

export function makeNodeStreamTrack(
  c: AttemptContext,
  node: RuntimeNode,
  latencyMs: number,
  { observeStreamUsage = true }: { observeStreamUsage?: boolean } = {},
) {
  // Once a stream is committed, no callback below needs the client body or
  // the matrix conversion context. Dropping them here avoids retaining large
  // prompt trees for the stream's lifetime; small bodies stay for hedge copies
  // and other short-lived uses.
  releaseLargeRequestBody(c);
  const tier1 = node.tier === 'tier-1';
  return {
    onAttemptUsage: (usage: unknown, outcome: 'success' | 'failure' | 'neutral') => {
      if (observeStreamUsage && usage != null) observeUpstreamAttemptUsage(c, usage);
      if (outcome !== 'success') recordUndeliveredUpstreamAttempt(c, node);
    },
    onSuccess: () => {
      recordNodeSuccess(c, node, latencyMs);
      gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
      gatewayStats.successes++;
    },
    onFailure: () => {
      if (!tier1) {
        const classification = classifyStreamInterrupted();
        recordFailure(node.id, { counted: classification.counted, cooldownMs: classification.cooldownMs, reason: classification.kind });
      }
      gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
      gatewayStats.failures++;
    },
    onNeutral: () => {
      if (tier1) releaseTier1Slot(node.id, c.tier1ReleaseToken);
      else recordNeutralEnd(node.id);
      gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
      gatewayStats.cancellations++;
    },
    onStreamStart: () => recordStreamStart(),
    onStreamEnd: (
      outcome: string,
      d: { reason: string | null; durationMs: number; chunkCount: number; receivedBytes: number; completionMarkerSeen: boolean },
    ) => {
      if (outcome === 'completed') {
        recordStreamCompleted();
        return;
      }
      if (outcome !== 'interrupted') return;
      recordStreamInterrupted(d.reason);
      if (tier1) {
        applyTier1Outcome(node.id, c.state?.requestedModel, classifyTier1Failure({ kind: classifyStreamInterrupted().kind, streamReason: d.reason }));
        releaseTier1Slot(node.id, c.tier1ReleaseToken);
        bumpNodeCounters(node.id, { requests: 1, failures: 1 });
      } else {
        applyHealthPenalty(node.id, 'stream');
      }
      c.logger.info(
        `[stream-interrupted] node=${node.id} provider=${node.provider}` +
          ` protocol=${c.upstreamProtocol ?? node.protocol} surface=${c.surface ?? node.surfaces?.[0] ?? ''}` +
          ` model=${c.requestedModel}->${upstreamModelOf(node, c.requestedModel)}` +
          ` reason=${d.reason} duration_ms=${d.durationMs} chunks=${d.chunkCount}` +
          ` received_bytes=${d.receivedBytes} completion_marker=${d.completionMarkerSeen}`,
      );
    },
  };
}
