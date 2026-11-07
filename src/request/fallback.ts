// SPDX-License-Identifier: MIT
// Backwards-compatible export: Gateway owns the protocol fallback policy and
// shared request-budget orchestration. This is not a second implementation.
export { runFallbackChain } from '../../apps/gateway/fallback.ts';
