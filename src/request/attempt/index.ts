// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Attempt Boundary - internal module map.
//
// src/request/attempt.ts remains the stable public boundary (handler.ts
// imports attemptNode / dispatchWithHedge from it); this directory holds the
// split internals:
//
//   dispatch.ts        one node attempt: outbound prep, timeouts, fetch,
//                      non-OK / network / client-abort classification entry
//   hedge.ts           hedge delay race, twin selection, shared deadline,
//                      winner/loser lifecycle + abort
//   success.ts         thin success-finalization dispatcher
//   success-stream.ts  first-event guard, stream passthrough/transforms,
//                      commit/lifecycle wiring
//   success-object.ts  complete-object assembly, conversion/synthesis,
//                      embedded-error and post-header result handling
//   outcome.ts         AttemptOutcome construction, failure/rotate/stop,
//                      logical attempt vs dispatch accounting
//   observability.ts   token accounting, D1 persistence scheduling, stream
//                      metrics, node success/TTFT recording (never affects
//                      scheduling decisions)
//
// Dependency direction (acyclic at runtime):
//   attempt.ts -> index.ts -> { dispatch.ts -> success.ts ->
//   { success-stream.ts, success-object.ts } -> observability.ts,
//   dispatch.ts -> outcome.ts, hedge.ts -> dispatch.ts }.
// success-stream.ts / success-object.ts import SuccessArgs from success.ts as
// a type-only contract, so they add no runtime cycle.
// No module here imports handler.ts, and nothing under reliability/ or
// transport/ imports anything from request/.

export { attemptNode } from './dispatch.ts';
export { dispatchWithHedge } from './hedge.ts';
