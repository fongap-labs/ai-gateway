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

export type { SubscriptionAdapter, SubscriptionDispatchContext, SubscriptionPreparedRequest } from './types.ts';

const ADAPTERS: Readonly<Record<string, SubscriptionAdapter>> = Object.freeze({
  openai: codexSubscriptionAdapter,
  anthropic: claudeSubscriptionAdapter,
  google: googleSubscriptionAdapter,
});

export function getSubscriptionAdapter(provider: string): SubscriptionAdapter | null {
  return ADAPTERS[provider] ?? null;
}

// Reset adapter state (used by tests; adapters are currently stateless but
// the hook keeps future stateful adapters testable).
export function __resetSubscriptionAdaptersForTests(): void {
  void 0;
}
