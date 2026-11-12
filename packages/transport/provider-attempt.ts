// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// One upstream HTTP attempt per authenticated private-center invocation.
// No Tier selection, model fallback, speculative retry or Provider credentials.
// Preserve the v1-v6 private error/disposition envelope exactly.
import { EXECUTION_ERROR_CODE, EXECUTION_WIRE_RESULT, serializeExecutionError } from '../contracts/execution.ts';

export type ProviderAttemptRequest = {
  url: string;
  headers: Headers;
  body: string;
  signal: AbortSignal;
  upstreamHeadersDeadlineMs: number;
};

export type ProviderAttemptResult = { upstream: Response; failure?: never } | { failure: Response; upstream?: never };

function problem(status: number, code: string, isRetryable = false): Response {
  return serializeExecutionError(status, code, { retryable: isRetryable });
}

export async function dispatchProviderAttempt(attempt: ProviderAttemptRequest): Promise<ProviderAttemptResult> {
  const remainingMs = attempt.upstreamHeadersDeadlineMs - Date.now();
  if (remainingMs <= 0) {
    const failure = problem(504, EXECUTION_ERROR_CODE.CENTER_UPSTREAM_HEADERS_TIMEOUT);
    failure.headers.set('x-aig-result', EXECUTION_WIRE_RESULT.SKIPPED);
    return { failure };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), remainingMs);
  const onAbort = () => controller.abort();
  if (attempt.signal.aborted) onAbort();
  else attempt.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const upstream = await fetch(attempt.url, {
      method: 'POST',
      headers: attempt.headers,
      body: attempt.body,
      signal: controller.signal,
      redirect: 'manual',
    });
    return { upstream };
  } catch {
    if (attempt.signal.aborted) return { failure: problem(499, 'center_client_aborted') };
    if (controller.signal.aborted) {
      const failure = problem(504, EXECUTION_ERROR_CODE.CENTER_UPSTREAM_HEADERS_TIMEOUT, true);
      failure.headers.set('x-aig-result', EXECUTION_WIRE_RESULT.ATTEMPTED);
      return { failure };
    }
    const failure = problem(502, EXECUTION_ERROR_CODE.CENTER_UPSTREAM_NETWORK, true);
    failure.headers.set('x-aig-result', EXECUTION_WIRE_RESULT.ATTEMPTED);
    return { failure };
  } finally {
    clearTimeout(timeoutId);
    attempt.signal.removeEventListener('abort', onAbort);
  }
}
