export const IMAGE_PROVIDER_IDS = ['openai-image', 'google-image', 'cloudflare-image'] as const;

export type ImageSize = '1024x1024' | '1024x1536' | '1536x1024';
export type ImageRoutingNode = {
  provider: string;
  auth?: string;
  baseUrl: string;
  models: Readonly<Record<string, string>>;
  surfaces: ReadonlyArray<string>;
};

const providers: ReadonlySet<string> = new Set(IMAGE_PROVIDER_IDS);
const sizes: ReadonlySet<string> = new Set(['1024x1024', '1024x1536', '1536x1024']);
const cloudflareModel = /^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/;

export function isImageGenerationProvider(provider: string): boolean {
  return typeof provider === 'string' && providers.has(provider.trim().toLowerCase());
}

export function canRouteImageGeneration(node: ImageRoutingNode, logicalModel: string, size: unknown): boolean {
  const provider = typeof node.provider === 'string' ? node.provider.trim().toLowerCase() : '';
  if (!isImageGenerationProvider(provider) || node.auth === 'oauth') return false;
  if (!node.surfaces.includes('images_generations') || !Object.hasOwn(node.models, logicalModel)) return false;
  const physicalModel = node.models[logicalModel];
  if (!physicalModel || typeof physicalModel !== 'string' || !sizes.has(size as string)) return false;
  try {
    if (!new URL(node.baseUrl).protocol) return false;
  } catch {
    return false;
  }
  if (provider === 'cloudflare-image') {
    return size === '1024x1024' && cloudflareModel.test(physicalModel);
  }
  return true;
}
