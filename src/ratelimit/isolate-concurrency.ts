// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Isolate-wide cap on concurrent body-carrying requests (AIG_REQUEST_ADMISSION).
//
// Every admitted request starts dispatches and streams that share the
// isolate's single CPU thread and its ~128MB of memory. Past a handful of
// concurrent juggernauts, wall-clock latency for ALL in-flight streams
// degrades together and the isolate risks the memory-recycling death that
// takes its streams and learned Tier 1 state with it. The cap is a blunt but
// cheap protector: one module-global counter, one increment, one release.
//
// Scope: only requests WITH a body are counted (they start upstream work).
// Bodyless requests — /health, /metrics, /models, the dashboard — are never
// refused for concurrency, so monitoring stays readable exactly when the
// gateway is busiest. A configured limit of 0 (or the flag being off) disables
// the gate entirely.

let inFlightRequests = 0;

/**
 * Count one request as in flight; returns the release function, or null when
 * the isolate is already at its cap (a limit <= 0 admits unconditionally).
 * The caller must release from a finally block on errors before it hands the
 * response to `releaseIsolateRequestAfterResponse`.
 */
export function admitIsolateRequest(maxInFlight: number): (() => void) | null {
  // Defensive: a disabled limit admits unconditionally instead of denying
  // traffic when a caller forgets to guard the 0 case.
  if (maxInFlight <= 0) return () => {};
  if (inFlightRequests >= maxInFlight) return null;
  inFlightRequests++;
  let isReleased = false;
  return () => {
    if (isReleased) return;
    isReleased = true;
    inFlightRequests = Math.max(0, inFlightRequests - 1);
  };
}

/** Keep an admitted slot until the response body reaches EOF, errors, or is cancelled. */
export function releaseIsolateRequestAfterResponse(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let isReleased = false;
  const releaseOnce = () => {
    if (isReleased) return;
    isReleased = true;
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseOnce();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        releaseOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      releaseOnce();
      try {
        await reader.cancel(reason);
      } catch {
        /* best-effort cancellation */
      }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function __resetIsolateConcurrencyForTests(): void {
  inFlightRequests = 0;
}
