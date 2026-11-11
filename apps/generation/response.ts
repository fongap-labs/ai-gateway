// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { EXECUTION_WIRE_RESULT, type ExecutionWireResult, serializeExecutionError } from '../../packages/contracts/execution.ts';

// Generation-private errors preserve the dispatched/attempted distinction.
export function problem(status: number, code: string, result: ExecutionWireResult = EXECUTION_WIRE_RESULT.NOT_DISPATCHED): Response {
  return serializeExecutionError(status, code, { result });
}
