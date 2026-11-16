import type { Surface } from '../types/protocol.ts';
import { googleImageGeneration } from './image-generation.ts';
import type { ProviderAdapter } from './types.ts';

export const googleImageProviderAdapter: ProviderAdapter = Object.freeze({
  id: 'google-image',
  wire: { protocol: 'openai' as const, surfaces: Object.freeze(['images_generations'] as Surface[]) },
  streamUsage: false,
  image: googleImageGeneration,
});
