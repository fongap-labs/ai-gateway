// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Credential-free provider routing metadata. Parsing a Gateway config must
// not instantiate Provider implementation modules.

import type { ExecutionSurface } from './execution.ts';

export type ProviderProfile = Readonly<{
  wire: Readonly<{ protocol: 'openai' | 'anthropic'; surfaces: ReadonlyArray<ExecutionSurface> }>;
  streamUsage: boolean;
}>;

const GENERIC_OPENAI_PROFILE: ProviderProfile = Object.freeze({
  wire: { protocol: 'openai', surfaces: ['chat_completions'] },
  streamUsage: true,
} as const);

const builtinProfiles: Readonly<Record<string, ProviderProfile>> = Object.freeze({
  openai: {
    wire: { protocol: 'openai', surfaces: ['chat_completions', 'responses'] },
    streamUsage: true,
  },
  anthropic: {
    wire: { protocol: 'anthropic', surfaces: ['messages'] },
    streamUsage: false,
  },
  google: {
    wire: { protocol: 'openai', surfaces: ['chat_completions'] },
    streamUsage: true,
  },
  'openai-image': { wire: { protocol: 'openai', surfaces: ['images_generations'] }, streamUsage: false },
  'google-image': { wire: { protocol: 'openai', surfaces: ['images_generations'] }, streamUsage: false },
  'cloudflare-image': { wire: { protocol: 'openai', surfaces: ['images_generations'] }, streamUsage: false },
});

export function getProviderProfile(provider: string): ProviderProfile {
  const key = String(provider || '')
    .trim()
    .toLowerCase();
  return builtinProfiles[key] ?? GENERIC_OPENAI_PROFILE;
}
