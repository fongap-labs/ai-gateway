import { type FailureKind, KIND } from '../../../src/reliability/classify.ts';
import { credentialSlotId } from '../../../src/reliability/shared-credential-group.ts';
import type { RuntimeNode } from '../../../src/types/node.ts';

export const RETRY_BUDGET_RATIO = 0.2;
export const RETRY_INDEPENDENT_KEY_RATIO = 0.4;
export const RETRY_BUDGET_MIN = 3;

export function isIndependentKeyRecovery(previousNode: RuntimeNode | undefined, candidate: RuntimeNode): boolean {
  return previousNode !== undefined && credentialSlotId(previousNode) !== credentialSlotId(candidate);
}

export function isCredentialWideFailure(attempt: Readonly<Record<string, unknown>>): boolean {
  if (attempt.dispatched !== true) return false;
  return attempt.status === 401 || (attempt.kind === KIND.RATE_LIMIT && attempt.rate_limit_scope === 'account');
}

export function preferUntriedCredentials(
  candidates: ReadonlyArray<RuntimeNode>,
  allNodes: ReadonlyArray<RuntimeNode>,
  priorAttemptNodeIds: Iterable<string>,
  attempted: ReadonlySet<string>,
): Set<string> | null {
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const usedCredentialIds = new Set<string>();
  for (const id of priorAttemptNodeIds) {
    const node = nodeById.get(id);
    if (node) usedCredentialIds.add(credentialSlotId(node));
  }
  if (!usedCredentialIds.size) return null;
  const preferredAttempted = new Set(attempted);
  let hasExcluded = false;
  for (const node of candidates) {
    if (!attempted.has(node.id) && usedCredentialIds.has(credentialSlotId(node))) {
      preferredAttempted.add(node.id);
      hasExcluded = true;
    }
  }
  return hasExcluded ? preferredAttempted : null;
}

let activeRequests = 0;
let retryingRequests = 0;
let deniedTotal = 0;

const SPECULATIVE_RETRY_AFTER: ReadonlySet<FailureKind> = new Set([
  KIND.SERVER,
  KIND.NETWORK,
  KIND.HEADERS_TIMEOUT,
  KIND.FIRST_EVENT_TIMEOUT,
  KIND.STREAM_INTERRUPTED,
  KIND.NON_JSON_BODY,
  KIND.EMPTY_200,
]);

export function isSpeculativeRetryAfter(kind: unknown): boolean {
  return typeof kind === 'string' && SPECULATIVE_RETRY_AFTER.has(kind as FailureKind);
}

export class RetrySlot {
  private isHeld = false;
  private isEnded = false;

  constructor() {
    activeRequests++;
  }

  tryAcquire(independentKey: boolean = false): boolean {
    if (this.isEnded) return false;
    if (this.isHeld) return true;
    const ratio = independentKey ? RETRY_INDEPENDENT_KEY_RATIO : RETRY_BUDGET_RATIO;
    const maxRetrying = Math.max(RETRY_BUDGET_MIN, Math.ceil(activeRequests * ratio));
    if (retryingRequests >= maxRetrying) {
      deniedTotal++;
      return false;
    }
    retryingRequests++;
    this.isHeld = true;
    return true;
  }

  end(): void {
    if (this.isEnded) return;
    this.isEnded = true;
    activeRequests = Math.max(0, activeRequests - 1);
    if (this.isHeld) retryingRequests = Math.max(0, retryingRequests - 1);
  }
}

export function snapshotRetryBudget(): { active: number; retrying: number; denied: number } {
  return { active: activeRequests, retrying: retryingRequests, denied: deniedTotal };
}

export function __resetRetryBudgetForTests(): void {
  activeRequests = 0;
  retryingRequests = 0;
  deniedTotal = 0;
}
