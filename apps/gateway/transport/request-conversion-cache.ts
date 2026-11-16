import type { ConversionResult } from '../../../src/conversion/result.ts';

const byRequest = new WeakMap<object, { body: object; entries: Map<string, Promise<ConversionResult>> }>();

export function reuseRequestConversionPreflight(
  requestState: object,
  body: object,
  pair: string,
  check: () => Promise<ConversionResult>,
): Promise<ConversionResult> {
  const previous = byRequest.get(requestState);
  const entry = previous?.body === body ? previous : { body, entries: new Map<string, Promise<ConversionResult>>() };
  if (entry !== previous) byRequest.set(requestState, entry);
  const cached = entry.entries.get(pair);
  if (cached) return cached;
  const pending = Promise.resolve().then(check);
  entry.entries.set(pair, pending);
  void pending.catch(() => {
    if (entry.entries.get(pair) === pending) entry.entries.delete(pair);
  });
  return pending;
}
