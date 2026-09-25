// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Subscription adapter registry. Maps provider names to the adapter that
// owns their subscription request semantics. The registry is the single
// place dispatch looks at; provider specifics never leak back out.

import { codexSubscriptionAdapter } from './openai.ts';
import { claudeSubscriptionAdapter } from './anthropic.ts';
import { googleSubscriptionAdapter } from './google.ts';
import type { SubscriptionAdapter } from './types.ts';
import type { RuntimeNode } from '../types/node.ts';

export type { SubscriptionAdapter, SubscriptionDispatchContext, SubscriptionPreparedRequest, SubscriptionFailureView } from './types.ts';

const ADAPTERS: Readonly<Record<string, SubscriptionAdapter>> = Object.freeze({
  openai: codexSubscriptionAdapter,
  anthropic: claudeSubscriptionAdapter,
  google: googleSubscriptionAdapter,
});

export function getSubscriptionAdapter(provider: string): SubscriptionAdapter | null {
  return ADAPTERS[provider] ?? null;
}

// The single binding point between "this node serves a subscription
// entitlement" and the credential form that proves it. Today subscription
// nodes authenticate through OAuth; a future credential form would only
// change this predicate (and the resolver it hands off to), never dispatch,
// scheduling, or the adapter contract. dispatch.ts must consult this
// predicate instead of node.auth directly so the equation never hardcodes
// again in the request path.
//
// This predicate describes INTENT, not servability: an auth:"oauth" node
// for a provider with no adapter still enters the subscription path and
// fails closed pre-dispatch via the adapter registry. Keeping unservable
// subscription nodes on that path is what guarantees they never send a
// half-shaped request upstream.
export function isSubscriptionNode(node: RuntimeNode): boolean {
  return node.auth === 'oauth';
}

// Reset adapter state (used by tests; adapters are currently stateless but
// the hook keeps future stateful adapters testable).
export function __resetSubscriptionAdaptersForTests(): void {
  void 0;
}
