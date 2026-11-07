// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Credential-free provider routing metadata. Parsing a Gateway config must
// not instantiate subscription/OAuth/image Provider implementation modules.

import type { ExecutionSurface } from './execution.ts';

export type ProviderProfile = Readonly<{
  wire: Readonly<{ protocol: 'openai' | 'anthropic'; surfaces: ReadonlyArray<ExecutionSurface> }>;
  streamUsage: boolean;
  subscriptionEndpoint?: string;
}>;

const GENERIC_OPENAI_PROFILE: ProviderProfile = Object.freeze({
  wire: { protocol: 'openai', surfaces: ['chat_completions'] },
  streamUsage: true,
});

const builtinProfiles: Readonly<Record<string, ProviderProfile>> = Object.freeze({
  openai: {
    wire: { protocol: 'openai', surfaces: ['chat_completions', 'responses'] },
    streamUsage: true,
    subscriptionEndpoint: 'https://api.openai.com',
  },
  anthropic: {
    wire: { protocol: 'anthropic', surfaces: ['messages'] },
    streamUsage: false,
    subscriptionEndpoint: 'https://api.anthropic.com',
  },
  google: {
    wire: { protocol: 'openai', surfaces: ['chat_completions'] },
    streamUsage: true,
    subscriptionEndpoint: 'https://cloudcode-pa.googleapis.com',
  },
  'openai-image': { wire: { protocol: 'openai', surfaces: ['images_generations'] }, streamUsage: false },
  'google-image': { wire: { protocol: 'openai', surfaces: ['images_generations'] }, streamUsage: false },
  'cloudflare-image': { wire: { protocol: 'openai', surfaces: ['images_generations'] }, streamUsage: false },
});

export function getProviderProfile(provider: string): ProviderProfile {
  const key = String(provider || '').trim().toLowerCase();
  return builtinProfiles[key] ?? GENERIC_OPENAI_PROFILE;
}
