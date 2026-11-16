import type { Protocol, Surface } from '../types/protocol.ts';
import type { ImageGenerationAdapter } from './image-generation.ts';

export type ProviderWire = Readonly<{
  protocol: Protocol;
  surfaces: ReadonlyArray<Surface>;
}>;

export type ProviderAdapter = Readonly<{
  id: string;
  wire: ProviderWire;
  streamUsage: boolean;
  image?: ImageGenerationAdapter;
}>;
