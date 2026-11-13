// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
// Credential-free usage hints for both private-center surfaces.
import { getProviderProfile } from './provider-profiles.ts';

export function streamUsageEnabled(
  node: { protocol?: string; surfaces?: ReadonlyArray<string>; provider?: string },
  env: Record<string, unknown> = {},
): boolean {
  const mode = String(env?.AIG_USAGE_INCLUDE_MODE ?? '')
    .trim()
    .toLowerCase();
  // An extra usage parameter can make otherwise valid Code/Chat requests
  // fail with HTTP 422 on OpenAI-compatible free endpoints. Never inject it
  // without an explicit operator opt-in; preserve legacy explicit "auto".
  if (!mode || mode === 'off') return false;
  if (mode === 'on') return true;
  if (mode !== 'auto') return false;
  if (!getProviderProfile(String(node?.provider ?? '')).streamUsage) return false;
  if (!Array.isArray(node?.surfaces) || !node.surfaces.includes('chat_completions')) return false;
  const offList = String(env?.AIG_USAGE_EXCLUDE_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const provider = String(node?.provider ?? '')
    .trim()
    .toLowerCase();
  return !(provider && offList.includes(provider));
}
