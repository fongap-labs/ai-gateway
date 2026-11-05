// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Image providers own native wire payloads; the gateway exposes one internal
// image-generation surface. No chat-to-image conversion or credential fallback.

import { buildTargetUrl } from '../protocol/http.ts';

export type ImageSize = '1024x1024' | '1024x1536' | '1536x1024';
export type ImageRequest = { prompt: string; size: ImageSize };
export type PreparedImageRequest = {
  url: string;
  body: Record<string, unknown>;
  auth: 'bearer' | 'google-key';
};
export type ImageGenerationAdapter = Readonly<{
  prepare: (baseUrl: string, upstreamModel: string, request: ImageRequest) => PreparedImageRequest | null;
  extract: (payload: unknown) => string | null;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function imageBase64(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 8 || value.length > 16 * 1024 * 1024) return null;
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  return value;
}

export const openAIImageGeneration: ImageGenerationAdapter = Object.freeze({
  prepare: (baseUrl, upstreamModel, request) => ({
    url: buildTargetUrl(baseUrl, '/v1/images/generations'),
    body: { model: upstreamModel, prompt: request.prompt, size: request.size, n: 1 },
    auth: 'bearer',
  }),
  extract: (payload) => {
    const data = record(payload)?.data;
    return Array.isArray(data) ? imageBase64(record(data[0])?.b64_json) : null;
  },
});

const GOOGLE_ASPECT: Readonly<Record<ImageSize, string>> = {
  '1024x1024': '1:1',
  '1024x1536': '2:3',
  '1536x1024': '3:2',
};

export const googleImageGeneration: ImageGenerationAdapter = Object.freeze({
  prepare: (baseUrl, upstreamModel, request) => ({
    url: buildTargetUrl(baseUrl, `/v1beta/models/${encodeURIComponent(upstreamModel)}:generateContent`),
    body: {
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: GOOGLE_ASPECT[request.size] } },
    },
    auth: 'google-key',
  }),
  extract: (payload) => {
    const candidates = record(payload)?.candidates;
    if (!Array.isArray(candidates)) return null;
    for (const candidate of candidates) {
      const parts = record(record(candidate)?.content)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (record(part)?.thought === true) continue;
        const inline = record(record(part)?.inlineData);
        const data = imageBase64(inline?.data);
        if (data && typeof inline?.mimeType === 'string' && inline.mimeType.startsWith('image/')) return data;
      }
    }
    return null;
  },
});

export const cloudflareImageGeneration: ImageGenerationAdapter = Object.freeze({
  prepare: (baseUrl, upstreamModel, request) => {
    // The model name becomes a path suffix; prevent arbitrary path/query injection.
    if (request.size !== '1024x1024' || !/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/.test(upstreamModel)) return null;
    return {
      url: buildTargetUrl(baseUrl, `/${upstreamModel}`),
      body: { prompt: request.prompt },
      auth: 'bearer',
    };
  },
  extract: (payload) => {
    const root = record(payload);
    return imageBase64(record(root?.result)?.image ?? root?.image);
  },
});
