// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import { anthropicProviderAdapter } from './anthropic.ts';
import { cloudflareImageProviderAdapter } from './cloudflare-image.ts';
import { genericOpenAIProviderAdapter } from './generic-openai.ts';
import { googleProviderAdapter } from './google.ts';
import { googleImageProviderAdapter } from './google-image.ts';
import { openAIProviderAdapter } from './openai.ts';
import { openAIImageProviderAdapter } from './openai-image.ts';
import type { ProviderAdapter, ProviderWire } from './types.ts';

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

export { streamUsageEnabled } from '../../packages/contracts/provider-usage.ts';
