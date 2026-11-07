// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Lightweight, credential-free image capability metadata shared by the
// Gateway control plane and the Generation execution plane. Provider-native
// request encoding and actual credentialed fetch remain center-only.

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
  return providers.has(provider);
}

/**
 * Preliminary control-plane eligibility only; NOT approval to execute.
 * Generation Center revalidates the selected node, URL, key and native body
 * before doing one potentially billable Provider attempt.
 */
export function canRouteImageGeneration(node: ImageRoutingNode, logicalModel: string, size: unknown): boolean {
  if (!isImageGenerationProvider(node.provider) || node.auth === 'oauth') return false;
  if (!node.surfaces.includes('images_generations') || !Object.hasOwn(node.models, logicalModel)) return false;
  const physicalModel = node.models[logicalModel];
  if (!physicalModel || typeof physicalModel !== 'string' || !sizes.has(size as string)) return false;
  try {
    // Match the native image adapters' URL parser without importing them
    // into Gateway. Transport protocol/userinfo policy is checked at config.
    if (!new URL(node.baseUrl).protocol) return false;
  } catch {
    return false;
  }
  if (node.provider === 'cloudflare-image') {
    return size === '1024x1024' && cloudflareModel.test(physicalModel);
  }
  return true;
}
