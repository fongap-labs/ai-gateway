// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Uniform random value in [0, 1) from Web Crypto.
export function cryptoRng(): number {
  const buf = crypto.getRandomValues(new Uint32Array(1));
  const random = buf[0] ?? 0;
  return random * 2 ** -32;
}
