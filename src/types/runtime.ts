// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Compatibility type-only re-exports. New application entrypoints depend
// directly on the neutral runtime contract, not this legacy location.
export type { ExecutionContextLike, GatewayEnv, GatewayLogger } from '../../packages/contracts/runtime.ts';
