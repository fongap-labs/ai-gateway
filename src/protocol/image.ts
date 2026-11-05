// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Strict input contract for the private, synchronous text-to-image tool.
// Provider-specific options require a separate capability; never silently
// discard an unknown field or pretend image editing is supported.

import type { ImageSize } from '../providers/image-generation.ts';

const IMAGE_SIZES: readonly ImageSize[] = ['1024x1024', '1024x1536', '1536x1024'];
const ALLOWED = new Set(['model', 'prompt', 'size', 'n', 'response_format']);

export function validateImageGenerationRequest(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  const value = body as Record<string, unknown>;
  for (const name of Object.keys(value)) {
    if (!ALLOWED.has(name)) return `Unsupported image request field "${name}".`;
  }
  if (typeof value.model !== 'string' || !value.model.trim()) return 'model must be a non-empty string.';
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 2048) {
    return 'prompt must be a non-empty string of no more than 2048 characters.';
  }
  if (value.size !== undefined && !IMAGE_SIZES.includes(value.size as ImageSize)) {
    return 'size must be 1024x1024, 1024x1536 or 1536x1024.';
  }
  if (value.n !== undefined && value.n !== 1) return 'Only n=1 is supported.';
  if (value.response_format !== undefined && value.response_format !== 'b64_json') {
    return 'Only response_format=b64_json is supported.';
  }
  return null;
}
