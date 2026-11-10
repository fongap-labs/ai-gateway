// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Credential-free provider routing metadata. Parsing a Gateway config must
// not instantiate Provider implementation modules.

import type { ExecutionSurface } from './execution.ts';

export type ProviderProfile = Readonly<{
  wire: Readonly<{ protocol: 'openai' | 'anthropic'; surfaces: ReadonlyArray<ExecutionSurface> }>;
  streamUsage: boolean;
  /** Explicit contract for image inputs on the provider's supported chat surfaces. */
  imageInput: boolean;
}>;

const GENERIC_OPENAI_PROFILE: ProviderProfile = Object.freeze({
  wire: { protocol: 'openai', surfaces: ['chat_completions'] },
  streamUsage: true,
  imageInput: false,
} as const);

const builtinProfiles: Readonly<Record<string, ProviderProfile>> = Object.freeze({
  openai: {
    wire: { protocol: 'openai', surfaces: ['chat_completions', 'responses'] },
    streamUsage: true,
    imageInput: true,
  },
  anthropic: {
    wire: { protocol: 'anthropic', surfaces: ['messages'] },
    streamUsage: false,
    imageInput: true,
  },
  google: {
    wire: { protocol: 'openai', surfaces: ['chat_completions'] },
    streamUsage: true,
    imageInput: false,
  },
  'openai-image': { wire: { protocol: 'openai', surfaces: ['images_generations'] }, streamUsage: false, imageInput: false },
  'google-image': { wire: { protocol: 'openai', surfaces: ['images_generations'] }, streamUsage: false, imageInput: false },
  'cloudflare-image': { wire: { protocol: 'openai', surfaces: ['images_generations'] }, streamUsage: false, imageInput: false },
});

export function getProviderProfile(provider: string): ProviderProfile {
  const key = String(provider || '')
    .trim()
    .toLowerCase();
  return builtinProfiles[key] ?? GENERIC_OPENAI_PROFILE;
}
