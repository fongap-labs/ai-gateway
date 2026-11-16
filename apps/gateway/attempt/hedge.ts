import { adaptiveHedgeDelayMs } from '../../../src/config/timeouts.ts';
import { classifyHedgeUnknown } from '../../../src/reliability/classify.ts';
import { getTier1ModelPerf } from '../../../src/reliability/tier1-state.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';
import type { AttemptContext, AttemptOutcome } from '../../../src/types/request.ts';
import type { PickedCandidate } from '../../../src/types/scheduler.ts';
import { cryptoRng } from '../../../src/utils/crypto-rng.ts';
import { pickCandidate } from '../scheduling/scheduler.ts';
import { pickTier1Candidate } from '../scheduling/tier1-scheduler.ts';
import { attemptNode, isBufferedUpstreamReply } from './dispatch.ts';

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const HEDGE_MAX_BODY_CHARS = 1024 * 1024;

export async function dispatchWithHedge(args: AttemptContext, tierNodes: ReadonlyArray<RuntimeNode>): Promise<AttemptOutcome> {
  if (args.route === 'openai_images') return attemptNode(args);
  const hedgePolicy = args.policy?.hedge ?? null;
  if (!hedgePolicy || hedgePolicy.enabled === false) return attemptNode(args);
  const tierKey: 'tier1' | 'tier2' = `tier${args.tierNumber}`;
  if (hedgePolicy.tiers && !hedgePolicy.tiers.includes(tierKey)) return attemptNode(args);
  if ((args.reqDescriptor.bodyChars ?? 0) > HEDGE_MAX_BODY_CHARS) return attemptNode(args);
  const configuredDelayMs = hedgePolicy.delayMs ?? args.limits.hedgeDelayMs;
  const hedgeDelayMs =
    hedgePolicy.delayMs !== undefined || args.limits.isHedgeDelayExplicit || configuredDelayMs <= 0
      ? configuredDelayMs
      : adaptiveHedgeDelayMs(configuredDelayMs, {
          bodyChars: args.reqDescriptor.bodyChars,
          ttftEwmaMs: args.tierNumber === 1 ? getTier1ModelPerf(args.node.id, args.state.requestedModel)?.ttftEwma : null,
          isBuffered: isBufferedUpstreamReply(args),
        });
  const maxHedges = args.limits.maxHedgesPerRequest ?? 1;
  if (hedgeDelayMs <= 0 || maxHedges <= 0) return attemptNode(args);

  const primaryArgs = { ...args, hedgeAbort: new AbortController() };
  const primary = attemptNode(primaryArgs);
  const verdict = await Promise.race([
    primary.then(
      () => 'settled',
      () => 'settled',
    ),
    sleepMs(hedgeDelayMs).then(() => 'hedge'),
  ]);
  if (verdict === 'settled') return primary;

  if (args.state.hedges >= maxHedges) return primary;
  if (args.state.dispatches + 2 > args.state.maxDispatches) return primary;
  const deadlineRemainingMs = (primaryArgs.attemptDeadlineMs ?? 0) - Date.now();
  if (deadlineRemainingMs <= 0) return primary;
  if (args.state.retrySlot && !args.state.retrySlot.tryAcquire()) return primary;
  const legacyTwin =
    args.tierNumber === 1
      ? null
      : pickCandidate(tierNodes, args.reqDescriptor, args.state.attempted, Date.now(), args.node.id, args.state.knownModels);
  const twinPick: PickedCandidate | null =
    args.tierNumber === 1
      ? pickTier1Candidate(tierNodes, args.reqDescriptor, args.state.attempted, {
          excludeId: args.node.id,
          now: Date.now(),
          rng: args.rng ?? cryptoRng,
          affinityAccountId: args.tier1AffinityAccountId,
          evaluateAffinity: args.tier1EvaluateAffinity,
          knownModels: args.state.knownModels,
          maxInFlight: args.policy?.maxInFlight ?? null,
        })
      : legacyTwin;
  if (!twinPick || twinPick.raceLost) return primary;
  const twinNode = twinPick.node as RuntimeNode;

  args.state.hedges++;
  primaryArgs.hedgedWithTwin = true;
  const logicalAttemptNo = args.state.logicalAttempts + 1;
  args.logger.info(
    `hedge: request=${args.requestId} logical_attempt=${logicalAttemptNo}/${args.state.maxAttempts}` +
      ` primary=${args.node.id} twin=${twinNode.id} delay_ms=${hedgeDelayMs}` +
      ` deadline_remaining_ms=${deadlineRemainingMs}`,
  );

  const twinArgs: AttemptContext = {
    ...args,
    node: twinNode,
    hedgeAbort: new AbortController(),
    hedgedAttempt: true,
    attemptDeadlineMs: primaryArgs.attemptDeadlineMs as number,
    tier1ReleaseToken: twinPick.releaseToken || null,
    tier1EscapedFromAffinity: !!twinPick.escapedFromAffinity,
    tier1UpdateAffinity: !!twinPick.updateAffinity,
  };
  const twin = attemptNode(twinArgs).then(undefined, (error) => {
    args.logger.debug(`hedge: twin ${twinNode.id} error ${error?.message || error}`);
    return { rotate: true, kind: classifyHedgeUnknown().kind };
  });
  const safePrimary = primary.then(undefined, (error) => {
    args.logger.debug(`hedge: primary ${args.node.id} error ${error?.message || error}`);
    return { rotate: true, kind: classifyHedgeUnknown().kind };
  });

  return new Promise((resolve) => {
    let isResolved = false;
    let settled = 0;
    let firstFailure: AttemptOutcome | null = null;
    let primaryOutcome: AttemptOutcome | null = null;
    let twinOutcome: AttemptOutcome | null = null;
    const win = (outcome: AttemptOutcome, winnerArgs: AttemptContext, loserAbort: AbortController | null | undefined) => {
      if (isResolved) {
        try {
          outcome.response?.body?.cancel();
        } catch {}
        return;
      }
      isResolved = true;
      loserAbort?.abort('Hedge lost');
      args.logger.info(
        `hedge winner: request=${args.requestId} logical_attempt=${logicalAttemptNo}/${args.state.maxAttempts}` +
          ` winner=${winnerArgs.node.id} loser=${(winnerArgs === primaryArgs ? twinNode : args.node).id}` +
          ` winner_ttft_ms=${winnerArgs.ttftMs ?? -1}`,
      );
      resolve(outcome);
    };
    const onSettled = (outcome: AttemptOutcome, isPrimary: boolean, loserAbort: AbortController | null | undefined) => {
      settled++;
      if (isPrimary) primaryOutcome = outcome;
      else twinOutcome = outcome;
      if (outcome.response) win(outcome, isPrimary ? primaryArgs : twinArgs, loserAbort);
      else {
        if (!firstFailure || isPrimary) firstFailure = outcome;
        if (settled >= 2 && !isResolved) {
          args.logger.info(
            `hedge failed: request=${args.requestId} logical_attempt=${logicalAttemptNo}/${args.state.maxAttempts}` +
              ` primary=${args.node.id} twin=${twinNode.id}` +
              ` primary_kind=${primaryOutcome?.kind || 'unknown'} twin_kind=${twinOutcome?.kind || 'unknown'}`,
          );
          resolve({ ...firstFailure });
        }
      }
    };
    safePrimary.then((o) => onSettled(o, true, twinArgs.hedgeAbort));
    twin.then((o) => onSettled(o, false, primaryArgs.hedgeAbort));
  });
}
