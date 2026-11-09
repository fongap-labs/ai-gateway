// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { QuotaSignal } from '../../../packages/contracts/quota-signal.ts';

// Quota signals are hints supplied by a trusted private center, never client
// headers. Reject oversized or malformed data; unknown remains unknown.
export function quotaFromCenter(headers: Headers): QuotaSignal | null {
  const encoded = headers.get('x-aig-quota-signal');
  if (!encoded || encoded.length > 512) return null;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const fields = ['remainingRequests', 'remainingTokens', 'limitRequests', 'limitTokens', 'resetAtMs'];
    const signal: QuotaSignal = { source: 'private-center' };
    for (const field of fields) {
      const value = record[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
      Object.assign(signal, { [field]: value });
    }
    return signal.remainingRequests === undefined && signal.remainingTokens === undefined ? null : signal;
  } catch {
    return null;
  }
}
