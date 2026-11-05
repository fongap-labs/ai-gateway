// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { Surface } from '../types/protocol.ts';
import { cloudflareImageGeneration } from './image-generation.ts';
import type { ProviderAdapter } from './types.ts';

// Workers AI REST model. Node base_url points to the account's /ai/run path.
export const cloudflareImageProviderAdapter: ProviderAdapter = Object.freeze({
  id: 'cloudflare-image',
  wire: { protocol: 'openai', surfaces: Object.freeze(['images_generations'] as Surface[]) },
  streamUsage: false,
  image: cloudflareImageGeneration,
});
