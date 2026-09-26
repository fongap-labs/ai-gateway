// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Provider registry: the single authority mapping provider names to their
// adapters. Every consumer (node config, dispatch, OAuth onboarding,
// discovery tooling) resolves provider knowledge through this module;
// there is no second provider switch anywhere in the gateway.
//
// Unknown providers resolve to the generic OpenAI-compatible adapter, so
// adding a plain OpenAI-compatible provider is pure configuration. A
// provider with its own wire contract, OAuth defaults, or subscription
// backend adds one module in src/providers/ plus one registry line.

import { genericOpenAIProviderAdapter } from './generic-openai.ts';
import { openAIProviderAdapter } from './openai.ts';
import { anthropicProviderAdapter } from './anthropic.ts';
import { googleProviderAdapter } from './google.ts';
import type { ProviderAdapter, ProviderWire, OAuthProviderConfig } from './types.ts';

const PROVIDER_REGISTRY: Readonly<Record<string, ProviderAdapter>> = Object.freeze({
  openai: openAIProviderAdapter,
  anthropic: anthropicProviderAdapter,
  google: googleProviderAdapter,
});

/** Resolve a provider name to its adapter. Unknown names resolve to the
 *  generic OpenAI-compatible adapter - never null. */
export function getProviderAdapter(provider: string): ProviderAdapter {
  const key = String(provider || '').trim().toLowerCase();
  return PROVIDER_REGISTRY[key] ?? genericOpenAIProviderAdapter;
}

/** The structural wire contract (protocol + routable surfaces) for a
 *  provider name. Single owner of the provider -> wire mapping. */
export function providerWire(provider: string): ProviderWire {
  return getProviderAdapter(provider).wire;
}

/** Built-in OAuth onboarding defaults for every registered provider that
 *  declares them, keyed by provider name. src/oauth/provider-configs.ts
 *  merges operator overrides (AIG_OAUTH_PROVIDERS) on top of this
 *  snapshot and never hardcodes provider defaults itself. */
export function builtinOAuthProviderConfigs(): Record<string, OAuthProviderConfig> {
  const defaults: Record<string, OAuthProviderConfig> = {};
  for (const [name, adapter] of Object.entries(PROVIDER_REGISTRY)) {
    if (adapter.oauth) defaults[name] = adapter.oauth;
  }
  return defaults;
}

/** Whether a streaming OpenAI chat dispatch should carry the passive
 *  `stream_options.include_usage` hint. Order:
 *    1. global kill switch  AIG_USAGE_INCLUDE_MODE=off -> never
 *    2. global force switch AIG_USAGE_INCLUDE_MODE=on  -> always
 *    3. auto: adapter-declared capability for this provider, minus the
 *       explicit AIG_USAGE_EXCLUDE_PROVIDERS off-list.
 *  Callers consult this only for effective chat_completions streams; the
 *  node's declared surfaces must still include chat_completions. */
export function streamUsageEnabled(
  node: { protocol?: string, surfaces?: ReadonlyArray<string>, provider?: string },
  env: Record<string, unknown> = {},
): boolean {
  const mode = String(env?.AIG_USAGE_INCLUDE_MODE ?? '').trim().toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  if (!getProviderAdapter(String(node?.provider ?? '')).streamUsage) return false;
  if (!Array.isArray(node?.surfaces) || !node.surfaces.includes('chat_completions')) return false;
  const offList = String(env?.AIG_USAGE_EXCLUDE_PROVIDERS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const provider = String(node?.provider ?? '').trim().toLowerCase();
  return !(provider && offList.includes(provider));
}
