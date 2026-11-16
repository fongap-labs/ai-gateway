// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { Surface } from '../types/protocol.ts';
import { openAIImageGeneration } from './image-generation.ts';
import type { ProviderAdapter } from './types.ts';

export const openAIImageProviderAdapter: ProviderAdapter = Object.freeze({
  id: 'openai-image',
  wire: { protocol: 'openai' as const, surfaces: Object.freeze(['images_generations'] as Surface[]) },
  streamUsage: false,
  image: openAIImageGeneration,
});
