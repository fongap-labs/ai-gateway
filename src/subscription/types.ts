// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Subscription adapter contract.
//
// An adapter owns the provider-specific request semantics of ONE
// subscription entitlement family (how a subscription node must be
// called). It NEVER decides which node to call (scheduler), how failures
// change node state (reliability), or how the response is classified
// (classify.ts) — it only shapes the outbound request.
//
// Dispatch pipeline position:
//   OAuth resolver (credential) -> adapter (request shape) -> transport (wire)
//
// Adapters are pure and fail-closed: an adapter that cannot shape a
// request returns null and the dispatch rotates the node.

import type { RuntimeNode } from '../types/node.ts';
import type { ResolvedSubscriptionCredential } from '../oauth/resolve.ts';

/** Read-only view of the dispatch attempt an adapter may inspect. */
export type SubscriptionDispatchContext = {
  node: RuntimeNode,
  credential: ResolvedSubscriptionCredential,
  /** The client request; adapters read headers from it but never forward
   *  client identity material (the transport's allowlist still applies to
   *  everything the adapter returns). */
  request: Request,
  /** The outbound body object after model substitution, before the adapter
   *  pass. Adapters may return a modified copy; they must not mutate it. */
  body: Record<string, unknown>,
  /** Effective surface of this attempt (post-fallback). */
  surface: string,
};

/** Provider-specific corrections for one subscription dispatch. */
export type SubscriptionPreparedRequest = {
  /** Headers applied last on top of the protocol/transport headers
   *  (same precedence as the old extra-headers path). */
  headers: Readonly<Record<string, string>>,
  /** Replacement body when the adapter rewrites it; null keeps the
   *  dispatch body untouched. */
  body: Record<string, unknown> | null,
  /** When set, replaces the dispatch target URL wholesale (used verbatim,
   *  with its own query string). Subscription backends with a proprietary
   *  wire path that is not expressible through resolveUpstreamPath(protocol,
   *  surface) (e.g. Google Code Assist's v1internal:generateContent and
   *  v1internal:streamGenerateContent?alt=sse) return it here; backends that
   *  reuse the node's native protocol path leave it null. */
  upstreamUrl: string | null,
};

/** A proprietary subscription wire: a subscription backend that speaks its
 *  own request/response shape instead of the node's native protocol. When a
 *  SubscriptionAdapter declares `wire`, the dispatch layer converts the OK
 *  upstream response into the node's native protocol shape BEFORE the success
 *  layer sees it, so every existing success/stream/object handler keeps one
 *  consistent contract. Streaming bodies are converted lazily (the converter
 *  must not emit before real output, so the first-event guard can still
 *  rotate); non-streaming objects are converted eagerly in the dispatch
 *  layer. Conversion is fail-closed: an object that carries no meaningful
 *  output rotates as an empty response. */
export type SubscriptionWire = {
  /** Convert a streaming proprietary upstream body into the node's native
   *  protocol SSE bytes. Must pipe upstream chunks through in real time,
   *  translate event types as they arrive, and emit the native terminal
   *  marker (e.g. OpenAI `data: [DONE]`) exactly once when the upstream
   *  stream ends. Must NOT buffer the full response before emitting. */
  streamToNative(
    body: ReadableStream<Uint8Array> | null | undefined,
    options: { messageId: string, model: string },
  ): ReadableStream<Uint8Array>,
  /** Convert one parsed proprietary response object into the node's native
   *  protocol object. Returns null when the response carries no meaningful
   *  output (an empty-response rotation in the dispatch layer). */
  objectToNative(data: unknown): Record<string, unknown> | null,
};

/** Read-only view of a failed subscription response an adapter may
 *  interpret. Values are exactly what the upstream produced; nothing is
 *  sanitized or truncated before the adapter sees it. */
export type SubscriptionFailureView = {
  status: number,
  headers: Headers,
  /** The upstream error body text (bounded by the dispatch diagnostic
   *  read limit), or the empty string when none was captured. */
  body: string,
};

export type SubscriptionAdapter = {
  /** Shape one subscription request. Returns null when the request cannot
   *  be shaped for this provider (fail-closed rotation). */
  prepare(ctx: SubscriptionDispatchContext): SubscriptionPreparedRequest | null,
  /** Interpret an upstream failure for quota-window semantics. Returns a
   *  cooldown hint in milliseconds when the provider's entitlement window
   *  (resets_at / window-reset markers) implies waiting longer than
   *  Retry-After alone, or null to leave the generic classification
   *  untouched. Hints are advisory: the caller caps them and still applies
   *  its own recovery model (cooldown expiry -> probe -> restore). */
  quotaResetHint?(failure: SubscriptionFailureView, now: number): number | null,
  /** Discover the upstream model ids this subscription credential can
   *  actually reach, best-effort. Returns null when discovery is not
   *  supported for the provider. Discovered ids are diagnostics for the
   *  operator (what the entitlement currently grants); static node.models
   *  routing configuration remains the routing authority. */
  discoverModels?(credential: ResolvedSubscriptionCredential, env: Record<string, unknown>): Promise<readonly string[] | null>,
  /** Declare a proprietary subscription wire. When present, the dispatch
   *  layer converts OK upstream responses into the node's native protocol
   *  shape through these converters before the success layer consumes them.
   *  Absent for backends that reuse the node's native protocol wire
   *  (Claude/Codex). */
  wire?: SubscriptionWire,
};
