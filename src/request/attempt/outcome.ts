// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Part of src/request/attempt.ts (behavior-preserving split); see
// attempt/index.ts for the module map.

// outcome.ts - AttemptOutcome construction and accounting: failure /
// rotate / stop outcomes, the logical-attempt vs dispatch charge rules,
// pre-dispatch neutral ends, and the single per-dispatch completion log.

import { trimDiagnostic } from '../../protocol/http.ts';
import {
  ADAPTIVE_429_QUOTA_START_STAGE,
  adaptive429StepsFromEnv,
  nextAdaptive429CooldownMs,
  snapshotAdaptive429State,
} from '../../reliability/adaptive-429.ts';
import type { FailureClassification, FailureKind } from '../../reliability/classify.ts';
import { classifyHedgeRaceLoss, KIND } from '../../reliability/classify.ts';
import { applyHealthPenalty, bumpNodeCounters, recordFailure, recordModelMissing, recordNeutralEnd } from '../../reliability/node-state.ts';
import { recordTier1ProviderModelRateLimit } from '../../reliability/tier1-heat.ts';
import {
  applyTier1Outcome,
  classifyTier1Failure,
  decideTier1RateLimitScope,
  recordTier1Oversize,
  releaseTier1Slot,
  settleTier1Quota,
} from '../../reliability/tier1-state.ts';
import type { RuntimeNode } from '../../types/node.ts';
import type { AttemptContext, AttemptOutcome, LoopState } from '../../types/request.ts';
import { upstreamModelOf } from '../response-helpers.ts';
import { recordUndeliveredUpstreamAttempt } from './observability.ts';

export function rotateWithNeutralEnd(
  state: LoopState,
  node: RuntimeNode,
  reason: FailureKind,
  c: Partial<AttemptContext> = {},
  isPreDispatch: boolean = false,
): AttemptOutcome {
  state.attempted.add(node.id);
  if (!isPreDispatch) {
    state.dispatches++;
    if (!c.hedgedAttempt) state.logicalAttempts++;
  }
  if (node.tier === 'tier-1') {
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    if (!isPreDispatch) bumpNodeCounters(node.id, { requests: 1 });
  } else {
    recordNeutralEnd(node.id);
  }
  noteFailure(state, reason);
  state.logger.info(
    `dispatch request=${c.requestId ?? state.requestId} logical_attempt=${isPreDispatch ? state.logicalAttempts + 1 : state.logicalAttempts}/${state.maxAttempts}` +
      ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}` +
      ` protocol=${c.upstreamProtocol ?? node.protocol} surface=${c.surface ?? ''} tier=${node.tier ?? ''}` +
      ` model=${state.requestedModel}->${upstreamModelOf(node, state.requestedModel)}` +
      ` hedged=${!!(c.hedgedAttempt || c.hedgedWithTwin)} kind=${reason} status=0 counted=false`,
  );
  state.attempts.push({
    attempt: state.logicalAttempts + (isPreDispatch ? 1 : 0),
    dispatch: state.dispatches,
    node_id: node.id,
    status: 0,
    kind: reason,
    hedged: !!(c.hedgedAttempt || c.hedgedWithTwin),
  });
  return isPreDispatch ? { rotate: true, budgetCharged: false, kind: reason } : { rotate: true, kind: reason };
}

export function noteFailure(state: LoopState, kind: FailureKind): void {
  state.failureKinds[kind] = (state.failureKinds[kind] || 0) + 1;
}

// A hedge loser cancelled because its peer committed first. Neutral by the
// reliability model (the node was slow, not broken): finalize its upstream
// accounting, release the concurrency slot, and never record a counted failure
// — the loss must not poison TTFT, health scoring, or the retry flow. Used by
// every phase where an aborted loser surfaces: the headers fetch
// (phase="headers"), the first-event guard (phase="first_event"), and
// post-headers object assembly (phase="object").
export function hedgeLoserOutcome(c: AttemptContext, node: RuntimeNode, phase: string, latencyMs?: number): AttemptOutcome {
  recordUndeliveredUpstreamAttempt(c, node);
  c.state.attempted.add(node.id);
  c.state.dispatches++;
  if (!c.hedgedAttempt) c.state.logicalAttempts++;
  if (node.tier === 'tier-1') {
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    bumpNodeCounters(node.id, { requests: 1 });
  } else recordNeutralEnd(node.id);
  const latency = latencyMs ?? (c.attemptStartMs ? Date.now() - c.attemptStartMs : -1);
  c.state.logger.info(
    `hedge loser: request=${c.requestId} node=${node.id} phase=${phase}` + ` reason=cancelled_after_peer_commit neutral=true latency_ms=${latency}`,
  );
  return { rotate: true, hedgedAway: true, kind: classifyHedgeRaceLoss().kind };
}

// Every call here represents a REAL upstream dispatch that did not become the
// delivered response. Finalize its upstream-attempt usage before reliability
// bookkeeping. The helper is exactly-once per AttemptContext and records
// missing coverage instead of estimating tokens when no report was observed.
export function recordOutcome(
  state: LoopState,
  node: RuntimeNode,
  classification: FailureClassification,
  c: AttemptContext,
  { latencyMs = -1, ttftWaitMs, status = 0, diagnostic }: { latencyMs?: number; ttftWaitMs?: number; status?: number; diagnostic?: string } = {},
): void {
  recordUndeliveredUpstreamAttempt(c, node);

  state.attempted.add(node.id);
  state.dispatches++;
  if (!c?.hedgedAttempt) state.logicalAttempts++;
  const hedged = !!(c?.hedgedAttempt || c?.hedgedWithTwin);
  const headersMs = c?.headersMs ?? (latencyMs >= 0 ? latencyMs : undefined);
  let tier1RateLimitStage: number | null = null;
  let tier1RateLimitCooldownMs: number | null = null;
  let tier1RateLimitScope: 'model' | 'account' | null = null;

  if (node.tier === 'tier-1') {
    // A failed dispatch still consumed a request slot upstream; confirm the
    // lease (no delivered token usage) so the reservation is not restored. The
    // 429 path below additionally writes a fresh quota report that may exhaust
    // the window; non-rate-limit failures keep the reactive cooldown model.
    settleTier1Quota(node.id, c.tier1ReleaseToken, 0);
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    if (classification.action === 'neutral') {
      bumpNodeCounters(node.id, { requests: 1 });
    } else {
      const upstreamModel = upstreamModelOf(node, state.requestedModel);
      let tier1RetryAfterMs = classification.retryAfterMs || 0;
      if (classification.requestTooLarge) recordTier1Oversize(node.id, state.requestedModel, c?.reqDescriptor?.bodyChars ?? 0);
      if (classification.kind === KIND.RATE_LIMIT) {
        recordTier1ProviderModelRateLimit(node.provider, upstreamModel, node.id);
        // A 429 is blamed on the model that got it; the whole key is blamed only
        // when a second model on it is limited too. Each scope has its own ladder.
        tier1RateLimitScope = decideTier1RateLimitScope(node.id, state.requestedModel);
        const ladderModel = tier1RateLimitScope === 'model' ? state.requestedModel : '';
        const ladderSteps = adaptive429StepsFromEnv(c.env?.AIG_RATE_LIMIT_STEPS_MS);
        const now = Date.now();
        tier1RetryAfterMs = nextAdaptive429CooldownMs(
          node.provider,
          node.id,
          classification.retryAfterMs || 0,
          now,
          ladderModel,
          ladderSteps,
          classification.rateLimitWindow === 'quota' ? ADAPTIVE_429_QUOTA_START_STAGE : 1,
        );
        const adaptive429 = snapshotAdaptive429State(node.provider, node.id, now, ladderModel);
        tier1RateLimitStage = adaptive429.stage;
        tier1RateLimitCooldownMs = adaptive429.cooldown_remaining_ms;
      }
      const t1Class = classifyTier1Failure(tier1RateLimitScope ? { ...classification, rateLimitScope: tier1RateLimitScope } : classification, {
        retryAfterMs: tier1RetryAfterMs,
      });
      const tier1ModelKey = classification.kind === KIND.MODEL_MISSING ? upstreamModel : state.requestedModel;
      applyTier1Outcome(node.id, tier1ModelKey, t1Class);
      bumpNodeCounters(node.id, { requests: 1, failures: 1 });
    }
  } else if (classification.modelScoped) {
    recordModelMissing(node.id, state.requestedModel, classification.cooldownMs || 0);
  } else if (classification.action === 'neutral') {
    recordNeutralEnd(node.id);
  } else {
    applyHealthPenalty(node.id, classification.kind);
    recordFailure(node.id, {
      counted: classification.counted,
      cooldownMs: classification.cooldownMs || 0,
      reason: classification.kind,
      explicitRetryAfter: classification.explicitRetryAfter,
    });
  }

  noteFailure(state, classification.kind);
  state.logger.info(
    `dispatch request=${c?.requestId ?? state.requestId} logical_attempt=${state.logicalAttempts}/${state.maxAttempts}` +
      ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}` +
      ` protocol=${c?.upstreamProtocol ?? node.protocol} surface=${c?.surface ?? ''} tier=${node.tier}` +
      ` model=${state.requestedModel}->${upstreamModelOf(node, state.requestedModel)}` +
      ` hedged=${hedged} kind=${classification.kind} status=${status} counted=${classification.counted}` +
      ` headers_ms=${headersMs ?? -1}${ttftWaitMs !== undefined ? ` ttft_wait_ms=${ttftWaitMs}` : ''}` +
      ` latency_ms=${latencyMs}` +
      `${tier1RateLimitStage !== null ? ` rate_limit_scope=${tier1RateLimitScope} rate_limit_stage=${tier1RateLimitStage} rate_limit_cooldown_ms=${tier1RateLimitCooldownMs ?? -1}` : ''}` +
      `${diagnostic && c?.exposeUpstreamInfo ? ` detail=${trimDiagnostic(diagnostic, 200)}` : ''}`,
  );

  const record: Record<string, unknown> = {
    attempt: state.logicalAttempts,
    dispatch: state.dispatches,
    node_id: node.id,
    provider: node.provider,
    protocol: c?.upstreamProtocol ?? node.protocol,
    surface: c?.surface,
    status,
    kind: classification.kind,
    hedged,
  };
  if (headersMs !== undefined && headersMs >= 0) record.headers_ms = headersMs;
  if (ttftWaitMs !== undefined && ttftWaitMs >= 0) record.ttft_wait_ms = ttftWaitMs;
  if (latencyMs >= 0) record.latency_ms = latencyMs;
  if (tier1RateLimitScope !== null) record.rate_limit_scope = tier1RateLimitScope;
  if (tier1RateLimitStage !== null) record.rate_limit_stage = tier1RateLimitStage;
  if (tier1RateLimitCooldownMs !== null) record.rate_limit_cooldown_ms = tier1RateLimitCooldownMs;
  if (c?.exposeUpstreamInfo && diagnostic) record.detail = trimDiagnostic(diagnostic, 300);
  state.attempts.push(record);
}
