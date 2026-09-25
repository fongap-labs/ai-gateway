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

import type { SubscriptionDispatchContext, SubscriptionPreparedRequest, SubscriptionFailureView, SubscriptionAdapter } from './types.ts';
import type { ResolvedSubscriptionCredential } from '../oauth/resolve.ts';
import { hintFromResetHeaders, hintFromSecondsHeaders, hintFromResetBody, capHint } from './quota-hints.ts';

export const CLAUDE_OAUTH_REQUIRED_BETAS: readonly string[] = Object.freeze([
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
]);
export const CLAUDE_CLI_USER_AGENT = 'claude-cli/1.0.57 (external, cli)';

// Claude/Anthropic quota markers: the platform exposes per-dimension
// remaining-seconds headers on 429s and a resets_in_seconds field in the
// quota error body. Hints only — the caller caps and recovers.
const CLAUDE_RESET_HEADERS = Object.freeze([
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-reset',
]);
const CLAUDE_RESET_BODY_FIELDS = Object.freeze(['resets_in_seconds', 'reset_at', 'resets_at']);

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

  quotaResetHint(failure: SubscriptionFailureView, now: number): number | null {
    if (failure.status !== 429) return null;
    const relative = hintFromSecondsHeaders(failure.headers, CLAUDE_RESET_HEADERS);
    const fromBody = hintFromResetBody(failure.body, CLAUDE_RESET_BODY_FIELDS);
    const resetAt = hintFromResetHeaders(failure.headers, CLAUDE_RESET_HEADERS, now) ?? fromBody;
    return capHint(resetAt, relative, now);
  },

  async discoverModels(credential: ResolvedSubscriptionCredential, _env: Record<string, unknown>): Promise<readonly string[] | null> {
    if (!credential.ok) return null;
    // The Anthropic model catalog with the same OAuth client shape a
    // shaped dispatch would send. Best-effort diagnostics: the node's
    // static models mapping stays the routing authority.
    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: {
          Authorization: `Bearer ${credential.token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': CLAUDE_OAUTH_REQUIRED_BETAS.join(','),
          'x-app': 'cli',
          'user-agent': CLAUDE_CLI_USER_AGENT,
        },
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    try {
      const payload = await response.json() as { data?: Array<{ id?: unknown }> };
      if (!Array.isArray(payload.data)) return null;
      const ids = payload.data
        .map((entry) => typeof entry?.id === 'string' ? entry.id : null)
        .filter((id): id is string => !!id);
      return Object.freeze(ids.sort());
    } catch {
      return null;
    }
  },
};
