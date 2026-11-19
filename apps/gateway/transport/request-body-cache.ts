import { patchNativeJsonTopLevel } from '../../../packages/transport/native-json-patch.ts';

const byRequest = new WeakMap<object, { body: Record<string, unknown>; variants: Map<string, string> }>();

export function releaseRequestBodyCache(requestState: object): void {
  byRequest.delete(requestState);
}

export function requestBodyForAttempt(
  requestState: object,
  body: Record<string, unknown>,
  raw: string | undefined,
  model: string,
  shouldForceStream: boolean,
): string {
  if (!shouldForceStream && raw) {
    if (body.model === model) return raw;
    if (typeof body.model === 'string') {
      const patched = patchNativeJsonTopLevel(raw, body.model, model, false);
      if (patched !== null) return patched;
    }
  }
  const previous = byRequest.get(requestState);
  const entry = previous?.body === body ? previous : { body, variants: new Map<string, string>() };
  if (entry !== previous) byRequest.set(requestState, entry);
  const key = `${shouldForceStream ? 'stream' : 'native'}:${model}`;
  const cached = entry.variants.get(key);
  if (cached !== undefined) return cached;
  const serialized = JSON.stringify(shouldForceStream ? { ...body, model, stream: true } : { ...body, model });
  entry.variants.set(key, serialized);
  return serialized;
}
