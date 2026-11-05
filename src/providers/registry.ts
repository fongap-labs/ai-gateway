// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { anthropicProviderAdapter } from './anthropic.ts';
import { cloudflareImageProviderAdapter } from './cloudflare-image.ts';
import { genericOpenAIProviderAdapter } from './generic-openai.ts';
import { googleProviderAdapter } from './google.ts';
import { googleImageProviderAdapter } from './google-image.ts';
import { openAIImageProviderAdapter } from './openai-image.ts';
import { openAIProviderAdapter } from './openai.ts';
import type { OAuthProviderConfig, ProviderAdapter, ProviderWire } from './types.ts';

const PROVIDER_REGISTRY: Readonly<Record<string, ProviderAdapter>> = Object.freeze({
  openai: openAIProviderAdapter,
  'openai-image': openAIImageProviderAdapter,
  anthropic: anthropicProviderAdapter,
  google: googleProviderAdapter,
  'google-image': googleImageProviderAdapter,
  'cloudflare-image': cloudflareImageProviderAdapter,
});

/** Unknown providers use the generic OpenAI-compatible adapter. */
export function getProviderAdapter(provider: string): ProviderAdapter {
  const key = String(provider || '')
    .trim()
    .toLowerCase();
  return PROVIDER_REGISTRY[key] ?? genericOpenAIProviderAdapter;
}

export function providerWire(provider: string): ProviderWire {
  return getProviderAdapter(provider).wire;
}

export function builtinOAuthProviderConfigs(): Record<string, OAuthProviderConfig> {
  const defaults: Record<string, OAuthProviderConfig> = {};
  for (const [name, adapter] of Object.entries(PROVIDER_REGISTRY)) {
    if (adapter.oauth) defaults[name] = adapter.oauth;
  }
  return defaults;
}

export function streamUsageEnabled(
  node: { protocol?: string; surfaces?: ReadonlyArray<string>; provider?: string },
  env: Record<string, unknown> = {},
): boolean {
  const mode = String(env?.AIG_USAGE_INCLUDE_MODE ?? '')
    .trim()
    .toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  if (!getProviderAdapter(String(node?.provider ?? '')).streamUsage) return false;
  if (!Array.isArray(node?.surfaces) || !node.surfaces.includes('chat_completions')) return false;
  const offList = String(env?.AIG_USAGE_EXCLUDE_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const provider = String(node?.provider ?? '')
    .trim()
    .toLowerCase();
  return !(provider && offList.includes(provider));
}
