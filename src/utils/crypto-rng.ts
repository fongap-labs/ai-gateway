// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

// Cryptographically secure uniform [0, 1) RNG for scheduling, jitter and
// routing contexts. Uses crypto.getRandomValues (Web Crypto API, available
// in Cloudflare Workers) instead of Math.random, which is not CSPRNG-backed.
export function cryptoRng(): number {
  const buf = crypto.getRandomValues(new Uint32Array(1));
  const random = buf[0] ?? 0;
  return random * 2 ** -32;
}
