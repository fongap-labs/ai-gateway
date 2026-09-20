// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Provider quirks — known compatibility DIFFERENCES between providers that
// share a wire profile. Structural protocol/surface ownership lives in
// provider-profile.ts; this module only answers narrow wire-format questions.

// Decide whether a streaming outbound request should carry
// `stream_options.include_usage` for a given runtime node. Order:
//   1. global kill switch  USAGE_INCLUDE_MODE=off -> never
//   2. global force switch USAGE_INCLUDE_MODE=on  -> always
//   3. auto: OpenAI chat_completions only, minus explicit provider off-list.
export function streamUsageSupported(
  node: { protocol?: string, surfaces?: ReadonlyArray<string>, provider?: string },
  env: Record<string, unknown> = {},
): boolean {
  const mode = String(env?.USAGE_INCLUDE_MODE ?? '').trim().toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  const protocol = String(node?.protocol ?? '').trim().toLowerCase();
  if (protocol !== 'openai') return false;
  if (!Array.isArray(node?.surfaces) || !node.surfaces.includes('chat_completions')) return false;
  const offList = String(env?.USAGE_EXCLUDE_PROVIDERS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const provider = String(node?.provider ?? '').trim().toLowerCase();
  return !(provider && offList.includes(provider));
}
