// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Subscription entry point. Provider-specific subscription request
// semantics live in the per-provider adapters under src/subscription/ and
// are composed into ProviderAdapters through src/providers/registry.ts -
// the provider registry is the single dispatchability authority. This
// module keeps only the node-level binding between "this node serves a
// subscription entitlement" and the credential form that proves it.

import type { RuntimeNode } from '../types/node.ts';

export type { SubscriptionAdapter, SubscriptionDispatchContext, SubscriptionPreparedRequest, SubscriptionFailureView } from './types.ts';

// The single binding point between "this node serves a subscription
// entitlement" and the credential form that proves it. Today subscription
// nodes authenticate through OAuth; a future credential form would only
// change this predicate (and the resolver it hands off to), never dispatch,
// scheduling, or the adapter contract. dispatch.ts must consult this
// predicate instead of node.auth directly so the equation never hardcodes
// again in the request path.
//
// This predicate describes INTENT, not servability: an auth:"oauth" node
// for a provider with no subscription adapter still enters the
// subscription path and fails closed pre-dispatch via the provider
// registry. Keeping unservable subscription nodes on that path is what
// guarantees they never send a half-shaped request upstream.
export function isSubscriptionNode(node: RuntimeNode): boolean {
  return node.auth === 'oauth';
}
