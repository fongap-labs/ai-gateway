import type { AttemptContext } from '../../../src/types/request.ts';
import { releaseRequestBodyCache } from '../transport/request-body-cache.ts';

export const LARGE_BODY_CHARS = 1024 * 1024;

export function releaseLargeRequestBody(c: AttemptContext): void {
  if ((c.reqDescriptor.bodyChars ?? 0) <= LARGE_BODY_CHARS) return;
  releaseRequestBodyCache(c.state);
  c.bodyJson = {};
  c.rawBody = undefined;
  c.conversionContext = null;
}
