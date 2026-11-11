// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Repair IME commas only outside quoted JSON strings. The deployment bridge
// and read-only model discovery must apply the same narrow transformation.
export function normalizeNodeConfigJsonText(text) {
  const source = String(text ?? '');
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '、' || ch === '，') {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      if (source[j] !== '}' && source[j] !== ']') out += ',';
      continue;
    }
    out += ch;
  }
  return out;
}
