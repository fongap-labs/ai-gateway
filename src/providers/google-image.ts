// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { Surface } from '../types/protocol.ts';
import { googleImageGeneration } from './image-generation.ts';
import type { ProviderAdapter } from './types.ts';

// API-key Gemini image endpoint, separate from OAuth Code Assist subscriptions.
export const googleImageProviderAdapter: ProviderAdapter = Object.freeze({
  id: 'google-image',
  wire: { protocol: 'openai', surfaces: Object.freeze(['images_generations'] as Surface[]) },
  streamUsage: false,
  image: googleImageGeneration,
});
