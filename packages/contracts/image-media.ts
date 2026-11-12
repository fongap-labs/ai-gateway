// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Image tool returns must be rendered with their real media type. Checking
// the byte signature avoids trusting a Provider's unvalidated file extension
// or labeling a non-PNG image as PNG in a Chat data URI.
export type GeneratedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export function generatedImageMime(base64: string): GeneratedImageMime | null {
  if (base64.length < 16 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  let prefix: string;
  try {
    prefix = atob(base64.slice(0, Math.min(base64.length, 32)));
  } catch {
    return null;
  }
  if (prefix.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (prefix.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}
