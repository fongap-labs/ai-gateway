import { commitTier1RecoveryProbe } from '../../../src/reliability/tier1-state.ts';
import type { AttemptContext, AttemptOutcome } from '../../../src/types/request.ts';
import { handleImageSuccess } from './success-image.ts';
import { handleMatrixSuccess, isMatrixConversion } from './success-matrix.ts';
import { handleObjectSuccess } from './success-object.ts';
import { handleStreamingSuccess } from './success-stream.ts';

export type SuccessArgs = {
  upstream: Response;
  c: AttemptContext;
  targetUrl: string;
  latencyMs: number;
  detach: () => void;
  upstreamWasStreaming: boolean;
  centerFramedStreamExpected?: boolean;
  attemptStartMs?: number;
};

export async function handleSuccess(s: SuccessArgs): Promise<AttemptOutcome> {
  if (s.c.route === 'openai_images') return handleImageSuccess(s);
  if (isMatrixConversion(s.c.conversionContext)) {
    return handleMatrixSuccess(s);
  }
  if (s.c.clientWantsStream && s.upstreamWasStreaming) {
    return handleStreamingSuccess(s);
  }
  if (s.c.node.tier === 'tier-1') {
    commitTier1RecoveryProbe(s.c.node.id, s.c.state?.requestedModel ?? s.c.requestedModel);
  }
  return handleObjectSuccess(s);
}
