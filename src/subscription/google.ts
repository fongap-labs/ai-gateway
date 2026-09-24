// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Google / Gemini subscription adapter.
//
// NO verified Gemini/Code Assist subscription backend exists behind the
// OpenAI-compatible Chat profile: the Gemini CLI OAuth token against the
// public Generative Language API consumes free-tier quotas, not the
// subscription entitlement, and the first-party Code Assist backend
// (cloudcode-pa.googleapis.com) speaks a proprietary protocol. Dispatch for
// google subscription nodes therefore fails closed — the adapter never
// shapes a request, so the dispatch rotates the node instead of pretending
// the entitlement is consumable through a generic path.

import type { SubscriptionDispatchContext, SubscriptionPreparedRequest, SubscriptionAdapter } from './types.ts';

export const googleSubscriptionAdapter: SubscriptionAdapter = {
  prepare(_ctx: SubscriptionDispatchContext): SubscriptionPreparedRequest | null {
    return null;
  },
};
