// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Anthropic / Claude Code subscription adapter.
//
// Semantics (mainstream reverse-proxy shape, cross-checked against
// claude-relay-service's OAuth account path; CLIProxyAPI agrees):
//   - OAuth subscription credentials authenticate through the required beta
//     flags. The client's own anthropic-beta list is preserved and the
//     required flags are appended when missing (deduplicated).
//   - x-app: cli and a first-party claude-cli user agent complete the
//     client shape. Client identity values are never forwarded from the
//     gateway's own clients.
//
// CCH billing-block signing (CLIProxyAPI's extra-paranoid layer) is NOT part
// of the mainstream shape and is not implemented here.

import type { SubscriptionDispatchContext, SubscriptionPreparedRequest, SubscriptionAdapter } from './types.ts';

export const CLAUDE_OAUTH_REQUIRED_BETAS: readonly string[] = Object.freeze([
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
]);
export const CLAUDE_CLI_USER_AGENT = 'claude-cli/1.0.57 (external, cli)';

export const claudeSubscriptionAdapter: SubscriptionAdapter = {
  prepare(ctx: SubscriptionDispatchContext): SubscriptionPreparedRequest | null {
    const { credential, request } = ctx;
    if (!credential.ok) return null;

    const clientBeta = (request.headers.get('anthropic-beta') || '')
      .split(',').map((part) => part.trim()).filter(Boolean);
    const seen = new Set(clientBeta);
    const mergedBeta = [
      ...clientBeta,
      ...CLAUDE_OAUTH_REQUIRED_BETAS.filter((beta) => !seen.has(beta)),
    ].join(',');

    return {
      headers: {
        'anthropic-beta': mergedBeta,
        'x-app': 'cli',
        'user-agent': CLAUDE_CLI_USER_AGENT,
      },
      body: null,
    };
  },
};
