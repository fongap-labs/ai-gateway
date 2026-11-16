// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Conservative fast path for already-validated native JSON requests. Rewrites
// only an unambiguous root "model" property at the beginning or end of an
// object; never searches/replaces a nested messages/tools payload.
//
// Unsupported layouts fall back to the normal object serializer. This is a
// CPU optimization, not a second request parser or a validation shortcut.
export function patchNativeJsonTopLevel(raw: string, logicalModel: string, physicalModel: string, shouldInjectStreamUsage: boolean): string | null {
  if (logicalModel === physicalModel && !shouldInjectStreamUsage) return raw;
  const first = /^\s*\{\s*"model"\s*:/.test(raw);
  const last = /,\s*"model"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}\s*$/.test(raw);
  if (!first && !last) return null;

  const keyAt = raw.indexOf('"model"');
  if (keyAt < 0 || raw.indexOf('"model"', keyAt + 7) !== -1) return null;
  const match = /^"model"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(raw.slice(keyAt));
  const modelValue = match?.[1];
  if (!match || modelValue === undefined) return null;
  try {
    if (JSON.parse(modelValue) !== logicalModel) return null;
  } catch {
    return null;
  }
  // Existing stream_options (including custom fields, false, null, or a
  // duplicated key) must pass through the original merge semantics.
  if (shouldInjectStreamUsage && raw.includes('"stream_options"')) return null;

  let out = raw;
  if (logicalModel !== physicalModel) {
    const valueAt = keyAt + match[0].length - modelValue.length;
    out = raw.slice(0, valueAt) + JSON.stringify(physicalModel) + raw.slice(valueAt + modelValue.length);
  }
  if (shouldInjectStreamUsage) {
    // The input has already passed JSON.parse with a root-object check.
    // Inserting before its last brace preserves the large nested values.
    const closingBrace = out.lastIndexOf('}');
    if (closingBrace < 0) return null;
    out = out.slice(0, closingBrace) + ',"stream_options":{"include_usage":true}' + out.slice(closingBrace);
  }
  return out;
}
