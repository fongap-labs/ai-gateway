// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

/** Detect only established image-bearing request structures; never inspect or decode payload data. */
export function hasImageInput(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const hasImageUrl = (value: unknown): boolean => {
    if (typeof value === 'string') return value.length > 0;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const image = value as Record<string, unknown>;
    return typeof image.url === 'string' && image.url.length > 0;
  };
  const hasContentImage = (content: unknown): boolean => {
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
      const item = part as Record<string, unknown>;
      if (item.type === 'image_url') return hasImageUrl(item.image_url);
      if (item.type === 'input_image') return hasImageUrl(item.image_url) || (typeof item.file_id === 'string' && item.file_id.length > 0);
      return item.type === 'image';
    });
  };
  if (hasContentImage(record.content)) return true;
  if (
    Array.isArray(record.input) &&
    record.input.some((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const input = item as Record<string, unknown>;
      return input.type === 'input_image'
        ? hasImageUrl(input.image_url) || (typeof input.file_id === 'string' && input.file_id.length > 0)
        : (input.type === 'message' || typeof input.role === 'string') && hasContentImage(input.content);
    })
  )
    return true;
  if (!Array.isArray(record.messages)) return false;
  return record.messages.some((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    return hasContentImage((message as Record<string, unknown>).content);
  });
}
