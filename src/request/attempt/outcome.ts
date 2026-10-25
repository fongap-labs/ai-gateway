// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Part of src/request/attempt.ts (behavior-preserving split); see
// attempt/index.ts for the module map.

// outcome.ts - AttemptOutcome construction and accounting: failure /
// rotate / stop outcomes, the logical-attempt vs dispatch charge rules,
// pre-dispatch neutral ends, and the single per-dispatch completion log.

import { clampRetryAfterMs } from '../../config/timeouts.ts';
import { trimDiagnostic } from '../../protocol/http.ts';
import {
  ADAPTIVE_429_QUOTA_START_STAGE,
  ADAPTIVE_429_QUOTA_STEPS_MS,
  ADAPTIVE_429_WINDOW_STEPS_MS,
  adaptive429StepsFromEnv,
  nextAdaptive429CooldownMs,
  snapshotAdaptive429State,
  TIER1_QUOTA_COOLDOWN_MAX_MS,
} from '../../reliability/adaptive-429.ts';
import type { FailureClassification, FailureKind } from '../../reliability/classify.ts';
import { classifyHedgeRaceLoss, KIND } from '../../reliability/classify.ts';
import { applyHealthPenalty, bumpNodeCounters, recordFailure, recordModelMissing, recordNeutralEnd } from '../../reliability/node-state.ts';
import { recordTier1ProviderModelRateLimit } from '../../reliability/tier1-heat.ts';
import { shareLongTier1Cooldowns } from '../../reliability/tier1-shared-cooldowns.ts';
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

// Failures that say nothing about the next request to the same Tier 1 key. When
// the request plan runs out, the most recent one of these may be retried once.
const SAME_NODE_RETRY_KINDS: ReadonlySet<FailureKind> = new Set([
  KIND.SERVER,
  KIND.NETWORK,
  KIND.HEADERS_TIMEOUT,
  KIND.FIRST_EVENT_TIMEOUT,
  KIND.STREAM_INTERRUPTED,
]);

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
    if (classification.action === 'neutral') {
      releaseTier1Slot(node.id, c.tier1ReleaseToken);
      bumpNodeCounters(node.id, { requests: 1 });
    } else {
      settleTier1Quota(node.id, c.tier1ReleaseToken, 0);
      releaseTier1Slot(node.id, c.tier1ReleaseToken);
    }
    if (classification.action !== 'neutral') {
      const upstreamModel = upstreamModelOf(node, state.requestedModel);
      let tier1RetryAfterMs = classification.retryAfterMs || 0;
      const tier1RateLimitClass: string | undefined = classification.rateLimitWindow;
      if (classification.requestTooLarge) recordTier1Oversize(node.id, state.requestedModel, c?.reqDescriptor?.bodyChars ?? 0);
      if (classification.kind === KIND.RATE_LIMIT) {
        recordTier1ProviderModelRateLimit(node.provider, upstreamModel, node.id);
        // A 429 is blamed on the model that got it; the whole key is blamed only
        // when a second model on it is limited too. Each scope has its own ladder.
        const observedScope = decideTier1RateLimitScope(node.id, state.requestedModel);
        // A long-lived allowance (quota wording, or a multi-minute wait hint) is
        // account-wide by nature: cool the whole key on the FIRST such 429 instead
        // of letting every model climb its own ladder against one shared pool.
        tier1RateLimitScope = classification.rateLimitWindow === 'quota' ? 'account' : observedScope;
        const now = Date.now();

        // Determine the adaptive-429 ladder to use. Only the response itself decides
        // the class: a window-classified 429 climbs the gentle window ladder and
        // stays on it however often its probe fails, because a per-minute limit
        // shared with other isolates and clients keeps refusing probes without
        // being a long-lived allowance. A quota-classified one (explicit horizon
        // wording or a long stated wait) climbs the long-allowance ladder and
        // already cools the whole key.
        const ladderModel = tier1RateLimitScope === 'model' ? state.requestedModel : '';
        const isWindowLadder = classification.rateLimitWindow === 'window';
        const isQuotaLadder = classification.rateLimitWindow === 'quota';
        const ladderSteps = isWindowLadder
          ? adaptive429StepsFromEnv(c.env?.AIG_RATE_LIMIT_WINDOW_STEPS_MS, ADAPTIVE_429_WINDOW_STEPS_MS)
          : isQuotaLadder
            ? adaptive429StepsFromEnv(c.env?.AIG_RATE_LIMIT_QUOTA_STEPS_MS, ADAPTIVE_429_QUOTA_STEPS_MS)
            : adaptive429StepsFromEnv(c.env?.AIG_RATE_LIMIT_STEPS_MS);
        // An unclassified account-wide 429 keeps the historical quota start stage
        // on the default ladder; a window 429 climbs from stage 1 even when the
        // observed scope is account-wide.
        const startStage = !isWindowLadder && !isQuotaLadder && tier1RateLimitScope === 'account' ? ADAPTIVE_429_QUOTA_START_STAGE : 1;

        tier1RetryAfterMs = nextAdaptive429CooldownMs(
          node.provider,
          node.id,
          Math.min(classification.retryAfterMs || 0, TIER1_QUOTA_COOLDOWN_MAX_MS),
          now,
          ladderModel,
          ladderSteps,
          startStage,
        );
        const adaptive429 = snapshotAdaptive429State(node.provider, node.id, now, ladderModel);
        tier1RateLimitStage = adaptive429.stage;
        tier1RateLimitCooldownMs = adaptive429.cooldown_remaining_ms;
      }
      const t1Class = classifyTier1Failure(
        tier1RateLimitScope ? { ...classification, rateLimitScope: tier1RateLimitScope, rateLimitClass: tier1RateLimitClass } : classification,
        { retryAfterMs: tier1RetryAfterMs },
      );
      const tier1ModelKey = classification.kind === KIND.MODEL_MISSING ? upstreamModel : state.requestedModel;
      // One timestamp for both, so a cooldown exactly at the sharing threshold is shared.
      const outcomeAt = Date.now();
      applyTier1Outcome(node.id, tier1ModelKey, t1Class, outcomeAt);
      shareLongTier1Cooldowns(c.env, c.ctx, node.id, outcomeAt);
      bumpNodeCounters(node.id, { requests: 1, failures: 1 });
      if (!state.hasRetriedSameNode && !c?.conversionContext && SAME_NODE_RETRY_KINDS.has(classification.kind)) {
        state.sameNodeRetry = { nodeId: node.id, model: state.requestedModel, latencyMs: Math.max(0, latencyMs) };
      }
    }
  } else if (classification.modelScoped) {
    recordModelMissing(node.id, state.requestedModel, classification.cooldownMs || 0);
  } else if (classification.action === 'neutral') {
    recordNeutralEnd(node.id);
  } else {
    applyHealthPenalty(node.id, classification.kind);
    // The paid-API reserve (Tier 3) keeps the ordinary Retry-After ceiling; only
    // Tier 1 learns long-lived allowances and Tier 2 subscription windows are
    // extended by the adapter's own reset hint.
    const nodeCooldownMs = classification.cooldownMs || 0;
    recordFailure(node.id, {
      counted: classification.counted,
      cooldownMs:
        node.tier === 'tier-3' && classification.kind === KIND.RATE_LIMIT && nodeCooldownMs > 0 ? clampRetryAfterMs(nodeCooldownMs) : nodeCooldownMs,
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
      `${tier1RateLimitStage !== null ? ` rate_limit_scope=${tier1RateLimitScope} rate_limit_class=${classification.rateLimitWindow ?? 'unknown'} rate_limit_stage=${tier1RateLimitStage} rate_limit_cooldown_ms=${tier1RateLimitCooldownMs ?? -1}` : ''}` +
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
  if (tier1RateLimitStage !== null) {
    record.rate_limit_class = classification.rateLimitWindow ?? 'unknown';
    record.rate_limit_stage = tier1RateLimitStage;
  }
  if (tier1RateLimitCooldownMs !== null) record.rate_limit_cooldown_ms = tier1RateLimitCooldownMs;
  if (c?.exposeUpstreamInfo && diagnostic) record.detail = trimDiagnostic(diagnostic, 300);
  state.attempts.push(record);
}
