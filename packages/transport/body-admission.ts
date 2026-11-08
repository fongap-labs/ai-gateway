// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Neutral byte-admission primitive. Each runtime owns its own pool: Gateway
// input admission and Inference Center execution MUST NOT share a counter
// when exercised in the same test process.
export const BODY_BYTES_IN_FLIGHT_BUDGET = 32 * 1024 * 1024;

export function createBodyAdmissionPool(limitBytes = BODY_BYTES_IN_FLIGHT_BUDGET): {
  admit: (declaredBytes: number, worstCaseBytes: number) => (() => void) | null;
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
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlightBytes = Math.max(0, inFlightBytes - bytes);
      };
    },
    reset() {
      inFlightBytes = 0;
    },
  };
}
