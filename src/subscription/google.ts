// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Google / Gemini subscription adapter.
//
// The Google One AI Premium / Gemini subscription entitlement is served by
// the Cloud Code Assist backend (cloudcode-pa.googleapis.com/v1internal),
// which speaks a proprietary wire (generateContent / streamGenerateContent).
// The adapter converts the gateway's OpenAI Chat Completions surface to/from
// that wire through src/subscription/google-wire.ts. The proprietary wire is
// subscription-owned: it never enters the gateway's general transport or
// conversion layers (the two native protocol families stay unchanged).
//
// Quota windows: the Code Assist backend announces RESOURCE_EXHAUSTED 429s
// with a gRPC RetryInfo retryDelay inside the error body and/or a standard
// Retry-After header. Hints only — the caller caps and recovers.
//
// Model discovery: the Code Assist backend exposes no verified model-list
// endpoint; the node's static models mapping stays the routing authority, so
// discovery is not supported (returns null).

import type { SubscriptionDispatchContext, SubscriptionPreparedRequest, SubscriptionFailureView, SubscriptionAdapter, SubscriptionWire } from './types.ts';
import type { ResolvedSubscriptionCredential } from '../oauth/resolve.ts';
import {
  GEMINI_CODE_ASSIST_ENDPOINT,
  GEMINI_CLI_USER_AGENT,
  CODE_ASSIST_PATH,
  openAIChatToCodeAssistEnvelope,
  codeAssistObjectToOpenAIChat,
  createOpenAIChatStreamFromCodeAssist,
} from './google-wire.ts';
import { hintFromRetryAfterHeader, hintFromRetryDelayBody, capHint } from './quota-hints.ts';

const GEMINI_WIRE: SubscriptionWire = {
  streamToNative(body, options) {
    return createOpenAIChatStreamFromCodeAssist(body, options);
  },
  objectToNative(data) {
    return codeAssistObjectToOpenAIChat(data);
  },
};

export const googleSubscriptionAdapter: SubscriptionAdapter = {
  prepare(ctx: SubscriptionDispatchContext): SubscriptionPreparedRequest | null {
    const { credential, node, body, surface } = ctx;
    if (!credential.ok) return null;
    // The Code Assist backend has one chat surface. Responses-surface
    // dispatch against a google node never reaches prepare() (the node's
    // wire surfaces are chat_completions-only), but defend anyway.
    if (surface !== 'chat_completions') return null;
    const built = openAIChatToCodeAssistEnvelope(body);
    if (!built) return null;
    let upstreamUrl: string;
    try {
      const url = new URL(node.baseUrl || GEMINI_CODE_ASSIST_ENDPOINT);
      url.pathname = built.streaming ? CODE_ASSIST_PATH.stream : CODE_ASSIST_PATH.object;
      url.search = built.streaming ? 'alt=sse' : '';
      upstreamUrl = url.toString();
    } catch {
      return null;
    }
    return {
      headers: {
        'user-agent': GEMINI_CLI_USER_AGENT,
        accept: built.streaming ? 'text/event-stream' : 'application/json',
      },
      body: built.envelope,
      upstreamUrl,
    };
  },

  quotaResetHint(failure: SubscriptionFailureView, now: number): number | null {
    if (failure.status !== 429) return null;
    const retryAfter = hintFromRetryAfterHeader(failure.headers, now);
    const retryDelay = hintFromRetryDelayBody(failure.body);
    const candidates: number[] = [];
    if (retryAfter !== null) candidates.push(retryAfter);
    if (retryDelay !== null) candidates.push(retryDelay);
    if (candidates.length === 0) return null;
    return capHint(null, Math.max(...candidates), now);
  },

  wire: GEMINI_WIRE,

  async discoverModels(_credential: ResolvedSubscriptionCredential, _env: Record<string, unknown>): Promise<readonly string[] | null> {
    // The Code Assist backend exposes no verified model-list endpoint; the
    // node's static models mapping is the routing authority. Discovery is
    // intentionally unsupported rather than guessing free-tier model ids.
    return null;
  },
};
