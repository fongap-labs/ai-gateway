// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// The scope is one request only. No Provider capability learning or persistent cache.
import type { ConversionResult } from '../../../src/conversion/result.ts';

const byRequest = new WeakMap<object, { body: object; entries: Map<string, ConversionResult> }>();

export async function reuseRequestConversionPreflight(
  requestState: object,
  body: object,
  pair: string,
  check: () => Promise<ConversionResult>,
): Promise<ConversionResult> {
  const previous = byRequest.get(requestState);
  if (previous && previous.body === body) {
    const hit = previous.entries.get(pair);
    if (hit) return hit;
  }
  // Do not reuse results across a mutated request body, even within the same
  // Gateway execution. In particular, image preprocessing changes body shape.
  const result = await check();
  const latest = byRequest.get(requestState);
  if (latest && latest.body === body) latest.entries.set(pair, result);
  else byRequest.set(requestState, { body, entries: new Map([[pair, result]]) });
  return result;
}
