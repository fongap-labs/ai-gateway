// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { EXECUTION_WIRE_RESULT, serializeExecutionError } from '../contracts/execution.ts';

// Private-center error envelope. Never include raw upstream payloads or tokens.
export function problem(status: number, code: string, isRetryable = false): Response {
  return serializeExecutionError(status, code, { retryable: isRetryable });
}

/** Explicitly signal that an OAuth subscription attempt never reached a Provider. */
export function preDispatchProblem(status: number, code: string): Response {
  const response = problem(status, code);
  response.headers.set('x-aig-result', EXECUTION_WIRE_RESULT.SKIPPED);
  return response;
}
