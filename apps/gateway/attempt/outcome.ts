// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Gateway-owned physical-attempt result, retry and failure settlement.

// outcome.ts - AttemptOutcome construction and accounting: failure /
// rotate / stop outcomes, the logical-attempt vs dispatch charge rules,
// pre-dispatch neutral ends, and the single per-dispatch completion log.

import { clampRetryAfterMs } from '../../../src/config/timeouts.ts';
import { logLazy } from '../../../src/observability/logger.ts';
import { recordProviderAttemptEvidence } from '../../../src/observability/provider-attempt-evidence.ts';
import { trimDiagnostic } from '../../../src/protocol/http.ts';
import {
  ADAPTIVE_429_QUOTA_START_STAGE,
  ADAPTIVE_429_QUOTA_STEPS_MS,
  ADAPTIVE_429_WINDOW_STEPS_MS,
  adaptive429StepsFromEnv,
  nextAdaptive429CooldownMs,
  snapshotAdaptive429State,
  TIER1_QUOTA_COOLDOWN_MAX_MS,
} from '../../../src/reliability/adaptive-429.ts';
import type { FailureClassification, FailureKind } from '../../../src/reliability/classify.ts';
import { classifyHedgeRaceLoss, KIND } from '../../../src/reliability/classify.ts';
import { applyHealthPenalty, bumpNodeCounters, recordFailure, recordModelMissing, recordNeutralEnd } from '../../../src/reliability/node-state.ts';
import { credentialPeers, credentialSlotId, noteKeyGroup429 } from '../../../src/reliability/shared-credential-group.ts';
import { recordTier1ProviderModelRateLimit } from '../../../src/reliability/tier1-heat.ts';
import {
  adoptTier1Cooldown,
  applyTier1Outcome,
  classifyTier1Failure,
  decideTier1RateLimitScope,
  getTier1Account,
  getTier1Model,
  recordTier1Oversize,
  releaseTier1Slot,
  settleTier1Quota,
} from '../../../src/reliability/tier1-state.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';
import type { AttemptContext, AttemptOutcome, LoopState } from '../../../src/types/request.ts';
import { shareLongTier1Cooldowns } from '../reliability/tier1-shared-cooldowns.ts';
import { upstreamModelOf } from '../response/response-helpers.ts';
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
  const effectiveModel = c.reqDescriptor?.model ?? state.requestedModel;
  logLazy(
    state.logger,
    'info',
    () =>
      `dispatch request=${c.requestId ?? state.requestId} logical_attempt=${isPreDispatch ? state.logicalAttempts + 1 : state.logicalAttempts}/${state.maxAttempts}` +
      ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}` +
      ` protocol=${c.upstreamProtocol ?? node.protocol} surface=${c.surface ?? ''} tier=${node.tier ?? ''}` +
      ` model=${state.requestedModel}${effectiveModel !== state.requestedModel ? `=>${effectiveModel}` : ''}->${upstreamModelOf(node, effectiveModel)}` +
      ` hedged=${!!(c.hedgedAttempt || c.hedgedWithTwin)} kind=${reason} status=0 counted=false`,
  );
  state.attempts.push({
    attempt: state.logicalAttempts + (isPreDispatch ? 1 : 0),
    dispatch: state.dispatches,
    node_id: node.id,
    tier: node.tier,
    effective_model: effectiveModel,
    dispatched: !isPreDispatch,
    status: 0,
    kind: reason,
    hedged: !!(c.hedgedAttempt || c.hedgedWithTwin),
  });
  return isPreDispatch ? { rotate: true, budgetCharged: false, kind: reason } : { rotate: true, kind: reason };
}

/**
 * A private center may return HTTP 200 with an invalid internal response
 * envelope AFTER dispatching the physical Provider request. This is a center
 * contract fault, not a bad key or a reason to retry the upstream. Settle the
 * undelivered usage and charge one neutral physical dispatch (including the
 * logical attempt) without cooling down the Provider.
 */
export function stopAfterDispatchedCenterFault(c: AttemptContext, response: Response): AttemptOutcome {
  recordUndeliveredUpstreamAttempt(c, c.node);
  rotateWithNeutralEnd(c.state, c.node, KIND.UNKNOWN, c);
  return { response, kind: KIND.UNKNOWN };
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
  logLazy(
    c.state.logger,
    'info',
    () =>
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
  // A model-family pass may dispatch a different logical model than the
  // client requested. Diagnostics must name the model actually sent upstream.
  const effectiveModel = c.reqDescriptor?.model ?? state.requestedModel;
  const physicalModel = upstreamModelOf(node, effectiveModel);
  if (classification.action !== 'neutral') {
    recordProviderAttemptEvidence({
      nodeId: node.id,
      upstreamModel: physicalModel,
      surface: c.surface ?? c.reqDescriptor?.surface ?? 'unknown',
      status,
      kind: classification.kind,
    });
  }
  // Endpoint/physical-route rejections are not credential failures.
  // Once two equivalent 422 dispatches fail, exclude remaining sibling Keys
  // for this request. Explicit endpoint 404s are excluded immediately.
  // Other physical routes and subsequent requests remain eligible.
  const failedSurface = c.surface ?? c.reqDescriptor?.surface;
  if ((classification.kind === KIND.ENDPOINT_NOT_FOUND || classification.physicalRouteFailure) && failedSurface) {
    // An opaque 422 is not proof that every Key on this physical route is
    // unusable. Permit one alternate Key before excluding equivalent routes.
    // Do not persist this as a model capability fact between requests.
    const previousSameRoute422 =
      status === 422 &&
      state.attempts.some((attempt) => {
        if (attempt.dispatched !== true || attempt.status !== 422) return false;
        const previousNode = (state.nodes ?? []).find((candidate) => candidate.id === attempt.node_id);
        return (
          previousNode?.tier === node.tier &&
          previousNode.provider === node.provider &&
          previousNode.baseUrl === node.baseUrl &&
          previousNode.protocol === node.protocol &&
          (attempt.surface ?? failedSurface) === failedSurface &&
          upstreamModelOf(previousNode, String(attempt.effective_model ?? effectiveModel)) === physicalModel
        );
      });
    if (status !== 422 || previousSameRoute422) {
      for (const peer of state.nodes ?? []) {
        if (
          peer.tier === node.tier &&
          peer.provider === node.provider &&
          peer.baseUrl === node.baseUrl &&
          peer.protocol === node.protocol &&
          peer.surfaces.includes(failedSurface) &&
          upstreamModelOf(peer, effectiveModel) === physicalModel
        ) {
          state.attempted.add(peer.id);
        }
      }
    }
  }
  const attemptWindowMs =
    c.attemptDeadlineMs !== undefined && c.attemptStartMs !== undefined ? Math.max(0, c.attemptDeadlineMs - c.attemptStartMs) : undefined;
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
      const upstreamModel = upstreamModelOf(node, effectiveModel);
      let tier1RetryAfterMs = classification.retryAfterMs || 0;
      const tier1RateLimitClass: string | undefined = classification.rateLimitWindow;
      if (classification.requestTooLarge) recordTier1Oversize(node.id, effectiveModel, c?.reqDescriptor?.bodyChars ?? 0);
      if (classification.kind === KIND.RATE_LIMIT) {
        recordTier1ProviderModelRateLimit(node.provider, upstreamModel, node.id);
        // A 429 is blamed on the model that got it; the whole key is blamed only
        // when a second model on it is limited too. Each scope has its own ladder.
        const observedScope = node.keyGroup ? noteKeyGroup429(node, upstreamModel) : decideTier1RateLimitScope(node.id, effectiveModel);
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
        const ladderModel = tier1RateLimitScope === 'model' ? effectiveModel : '';
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
          credentialSlotId(node),
          Math.min(classification.retryAfterMs || 0, TIER1_QUOTA_COOLDOWN_MAX_MS),
          now,
          ladderModel,
          ladderSteps,
          startStage,
        );
        const adaptive429 = snapshotAdaptive429State(node.provider, credentialSlotId(node), now, ladderModel);
        tier1RateLimitStage = adaptive429.stage;
        tier1RateLimitCooldownMs = adaptive429.cooldown_remaining_ms;
      }
      const t1Class = classifyTier1Failure(
        tier1RateLimitScope ? { ...classification, rateLimitScope: tier1RateLimitScope, rateLimitClass: tier1RateLimitClass } : classification,
        { retryAfterMs: tier1RetryAfterMs },
      );
      const tier1ModelKey = classification.kind === KIND.MODEL_MISSING ? upstreamModel : effectiveModel;
      // One timestamp for both, so a cooldown exactly at the sharing threshold is shared.
      const outcomeAt = Date.now();
      applyTier1Outcome(node.id, tier1ModelKey, t1Class, outcomeAt);
      // Share the relevant cooldown across node IDs only when the operator
      // explicitly declares they use the SAME upstream credential.
      if (node.keyGroup) {
        const peers = credentialPeers(state.nodes ?? [], node);
        if (
          t1Class.scope === 'account' &&
          (classification.kind === KIND.RATE_LIMIT || (classification.kind === KIND.AUTH && !classification.forbidden))
        ) {
          const owner = getTier1Account(node.id);
          for (const peer of peers) {
            adoptTier1Cooldown(
              {
                node: peer.id,
                until: owner.accountCooldownUntil,
                reason: owner.accountCooldownReason ?? classification.kind,
                ...(owner.accountCooldownIsQuota ? { quota: true } : {}),
              },
              outcomeAt,
            );
          }
        } else if (classification.kind === KIND.RATE_LIMIT && t1Class.scope === 'model') {
          const modelUntil = getTier1Model(node.id, effectiveModel).cooldownUntil;
          if (modelUntil > outcomeAt) {
            for (const peer of peers) {
              for (const [alias, physical] of Object.entries(peer.models)) {
                if (physical === upstreamModel) {
                  adoptTier1Cooldown({ node: peer.id, model: alias, until: modelUntil, reason: classification.kind }, outcomeAt);
                }
              }
            }
          }
        }
      }
      shareLongTier1Cooldowns(c.env, c.ctx, node.id, outcomeAt);
      bumpNodeCounters(node.id, { requests: 1, failures: 1 });
    }
  } else if (classification.modelScoped) {
    recordModelMissing(node.id, effectiveModel, classification.cooldownMs || 0);
  } else if (classification.action === 'neutral') {
    recordNeutralEnd(node.id);
  } else {
    applyHealthPenalty(node.id, classification.kind);
    // Paid API Token nodes (new Tier 2) retain the ordinary Retry-After
    // ceiling; only Tier 1 learns long-lived free allowance limits.
    const nodeCooldownMs = classification.cooldownMs || 0;
    recordFailure(node.id, {
      counted: classification.counted,
      cooldownMs:
        node.tier === 'tier-2' && classification.kind === KIND.RATE_LIMIT && nodeCooldownMs > 0 ? clampRetryAfterMs(nodeCooldownMs) : nodeCooldownMs,
      reason: classification.kind,
      explicitRetryAfter: classification.explicitRetryAfter,
    });
  }

  noteFailure(state, classification.kind);
  logLazy(
    state.logger,
    'info',
    () =>
      `dispatch request=${c?.requestId ?? state.requestId} logical_attempt=${state.logicalAttempts}/${state.maxAttempts}` +
      ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}` +
      ` protocol=${c?.upstreamProtocol ?? node.protocol} surface=${c?.surface ?? ''} tier=${node.tier}` +
      `${c?.traceparent ? ` trace_span_id=${c.traceparent.split('-')[2]}` : ''}` +
      ` model=${state.requestedModel}${effectiveModel !== state.requestedModel ? `=>${effectiveModel}` : ''}->${physicalModel}` +
      ` hedged=${hedged} kind=${classification.kind} status=${status} counted=${classification.counted}` +
      ` headers_ms=${headersMs ?? -1}${ttftWaitMs !== undefined ? ` ttft_wait_ms=${ttftWaitMs}` : ''}` +
      ` latency_ms=${latencyMs}${attemptWindowMs !== undefined ? ` attempt_window_ms=${attemptWindowMs}` : ''}` +
      `${tier1RateLimitStage !== null ? ` rate_limit_scope=${tier1RateLimitScope} rate_limit_class=${classification.rateLimitWindow ?? 'unknown'} rate_limit_stage=${tier1RateLimitStage} rate_limit_cooldown_ms=${tier1RateLimitCooldownMs ?? -1}` : ''}` +
      `${diagnostic && c?.exposeUpstreamInfo ? ` detail=${trimDiagnostic(diagnostic, 200)}` : ''}`,
  );

  const record: Record<string, unknown> = {
    attempt: state.logicalAttempts,
    dispatch: state.dispatches,
    node_id: node.id,
    provider: node.provider,
    tier: node.tier,
    dispatched: true,
    effective_model: effectiveModel,
    upstream_model: physicalModel,
    protocol: c?.upstreamProtocol ?? node.protocol,
    surface: c?.surface,
    status,
    kind: classification.kind,
    hedged,
  };
  if (headersMs !== undefined && headersMs >= 0) record.headers_ms = headersMs;
  if (ttftWaitMs !== undefined && ttftWaitMs >= 0) record.ttft_wait_ms = ttftWaitMs;
  if (latencyMs >= 0) record.latency_ms = latencyMs;
  if (attemptWindowMs !== undefined) record.attempt_window_ms = attemptWindowMs;
  if (tier1RateLimitScope !== null) record.rate_limit_scope = tier1RateLimitScope;
  if (tier1RateLimitStage !== null) {
    record.rate_limit_class = classification.rateLimitWindow ?? 'unknown';
    record.rate_limit_stage = tier1RateLimitStage;
  }
  if (tier1RateLimitCooldownMs !== null) record.rate_limit_cooldown_ms = tier1RateLimitCooldownMs;
  if (c?.exposeUpstreamInfo && diagnostic) record.detail = trimDiagnostic(diagnostic, 300);
  state.attempts.push(record);
}
