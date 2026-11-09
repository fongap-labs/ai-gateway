// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Stable legacy request-attempt entry. The real hedge and per-attempt
// selector now belong to Gateway; this file never executes Provider calls.
export { attemptNode } from '../../../apps/gateway/attempt/dispatch.ts';
export { dispatchWithHedge } from '../../../apps/gateway/attempt/hedge.ts';
