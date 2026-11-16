import { KIND } from '../../../src/reliability/classify.ts';

const NON_FAILURE_KINDS: ReadonlySet<string> = new Set([KIND.CLIENT_ABORT, KIND.CANCELLED_AFTER_PEER_COMMIT]);

export function hasConfirmedUpstreamFailure(attempts: ReadonlyArray<Record<string, unknown>>): boolean {
  return attempts.some((attempt) => {
    if (attempt.dispatched !== true || typeof attempt.kind !== 'string') return false;
    if (NON_FAILURE_KINDS.has(attempt.kind)) return false;
    return Object.values(KIND).some((kind) => kind === attempt.kind);
  });
}
