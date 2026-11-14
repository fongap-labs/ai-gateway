// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Neutral byte-admission primitive. Each runtime owns its own pool: Gateway
// input admission and Inference Center execution MUST NOT share a counter
// when exercised in the same test process.
export const BODY_BYTES_IN_FLIGHT_BUDGET = 32 * 1024 * 1024;

export function createBodyAdmissionPool(limitBytes = BODY_BYTES_IN_FLIGHT_BUDGET): {
  admit: (declaredBytes: number, worstCaseBytes: number) => (() => void) | null;
  admitGrowing: (declaredBytes: number, hasBody: boolean) => { observe: (actualBytes: number) => boolean; release: () => void } | null;
  reset: () => void;
} {
  let inFlightBytes = 0;
  return {
    admit(declaredBytes, worstCaseBytes) {
      const declared = Number.isSafeInteger(declaredBytes) && declaredBytes > 0 ? declaredBytes : 0;
      const worstCase = Number.isSafeInteger(worstCaseBytes) && worstCaseBytes > 0 ? worstCaseBytes : 0;
      const bytes = declared > 0 ? declared : worstCase;
      if (bytes > 0 && inFlightBytes > 0 && inFlightBytes + bytes > limitBytes) return null;
      inFlightBytes += bytes;
      let isReleased = false;
      return () => {
        if (isReleased) return;
        isReleased = true;
        inFlightBytes = Math.max(0, inFlightBytes - bytes);
      };
    },
    // Unknown-length requests reserve only a small initial allowance, then
    // account for each actual chunk BEFORE buffering it. Concurrent bodies can
    // grow only while their combined measured size stays inside the budget.
    admitGrowing(declaredBytes, hasBody) {
      const declared = Number.isSafeInteger(declaredBytes) && declaredBytes > 0 ? declaredBytes : 0;
      const minimum = hasBody ? 128 * 1024 : 0;
      let charged = hasBody ? Math.max(minimum, declared) : 0;
      if (charged > 0 && inFlightBytes > 0 && inFlightBytes + charged > limitBytes) return null;
      inFlightBytes += charged;
      let released = false;
      return {
        observe(actualBytes) {
          if (released || !Number.isSafeInteger(actualBytes) || actualBytes < 0) return false;
          if (actualBytes <= charged) return true;
          const otherBytes = Math.max(0, inFlightBytes - charged);
          if (otherBytes > 0 && otherBytes + actualBytes > limitBytes) return false;
          inFlightBytes = otherBytes + actualBytes;
          charged = actualBytes;
          return true;
        },
        release() {
          if (released) return;
          released = true;
          inFlightBytes = Math.max(0, inFlightBytes - charged);
        },
      };
    },
    reset() {
      inFlightBytes = 0;
    },
  };
}
