// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Unified provider adapter contract.
//
// A ProviderAdapter is the single declaration point for everything the
// gateway knows about ONE upstream provider family: its structural wire
// contract (protocol + routable surfaces), narrow wire-format quirks,
// built-in OAuth onboarding defaults, and subscription request semantics.
// The router, scheduler, reliability and transport layers stay
// provider-agnostic: they consume Protocol/Surface/credential facts and
// never branch on provider names.
//
// Adding a plain OpenAI-compatible provider needs no source change at all
// (the generic-openai adapter is the registry fallback). Adding a provider
// with its own wire contract, OAuth onboarding, or subscription backend
// means adding one module in src/providers/ plus its registry line.

import type { Protocol, Surface } from '../types/protocol.ts';
import type { SubscriptionAdapter } from '../subscription/types.ts';

/** Structural wire contract: which protocol the provider speaks and which
 *  upstream surfaces are routable. This is provider knowledge, not
 *  per-account configuration; node records cannot override it. */
export type ProviderWire = Readonly<{
  protocol: Protocol,
  surfaces: ReadonlyArray<Surface>,
}>;

/** Built-in OAuth onboarding defaults for one provider (public constants
 *  from the provider's first-party CLI, not secrets). AIG_OAUTH_PROVIDERS
 *  entries replace these per-provider wholesale; the parse/merge/cache
 *  machinery stays in src/oauth/provider-configs.ts. */
export type OAuthUpstreamHeaders = Readonly<Record<string, string>>;

export type OAuthProviderConfig = {
  authorizeUrl: string,
  tokenUrl: string,
  clientId: string,
  scope: string,
  clientSecret?: string,
  /** When set, the authorize redirect goes to this URL (not the gateway
   *  callback) and the operator must paste the code at /oauth/paste.
   *  Required for providers whose OAuth client does not allow arbitrary
   *  redirect URIs (e.g., Google). */
  manualRedirectUrl?: string,
  upstreamHeaders: OAuthUpstreamHeaders,
};

export type ProviderAdapter = Readonly<{
  /** Registry key: the provider name used in node configuration. */
  id: string,
  wire: ProviderWire,
  /** Whether this provider's OpenAI chat_completions stream accepts the
   *  passive `stream_options.include_usage` hint in auto mode. Operator
   *  switches (AIG_USAGE_INCLUDE_MODE / AIG_USAGE_EXCLUDE_PROVIDERS) still
   *  apply on top of this declaration. */
  streamUsage: boolean,
  /** Built-in OAuth onboarding defaults; absent for providers without an
   *  OAuth subscription onboarding story. */
  oauth?: OAuthProviderConfig,
  /** Subscription dispatch semantics for Tier 2 auth:"oauth" nodes.
   *  Absent means the provider has no verified subscription backend and
   *  subscription dispatch fails closed (pre-dispatch rotation). */
  subscription?: SubscriptionAdapter,
}>;
