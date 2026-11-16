// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
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
  const result = await check();
  const latest = byRequest.get(requestState);
  if (latest && latest.body === body) latest.entries.set(pair, result);
  else byRequest.set(requestState, { body, entries: new Map([[pair, result]]) });
  return result;
}
