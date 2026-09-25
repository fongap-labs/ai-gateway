// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// OpenAI / ChatGPT / Codex subscription adapter.
//
// Semantics (from the first-party codex-tui wire behavior, cross-checked
// against CLIProxyAPI's codex executor):
//   - The ChatGPT subscription backend identifies the subscription account
//     via the chatgpt-account-id header (the OAuth token response carries
//     account_id).
//   - The first-party originator marker is required; client-supplied
//     Originator values are never forwarded.
//   - The Responses wire shape must carry the `instructions` field; the
//     first-party client always sends one (empty when none). Client-provided
//     instructions pass through verbatim.

import type { SubscriptionDispatchContext, SubscriptionPreparedRequest, SubscriptionFailureView, SubscriptionAdapter } from './types.ts';
import type { ResolvedSubscriptionCredential } from '../oauth/resolve.ts';
import { hintFromResetHeaders, hintFromSecondsHeaders, hintFromResetBody, capHint } from './quota-hints.ts';

const CODEX_ORIGINATOR = 'codex-tui';

// Codex/ChatGPT subscription quota markers: absolute window-reset
// instants (epoch seconds) on headers plus a seconds-until-reset body
// field on quota errors. Hints only — the caller caps and recovers.
const CODEX_RESET_HEADERS = Object.freeze([
  'x-codex-primary-used-window-reset',
  'x-codex-secondary-used-window-reset',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
]);
const CODEX_RESET_BODY_FIELDS = Object.freeze(['resets_in_seconds', 'reset_at', 'resets_at']);

export const codexSubscriptionAdapter: SubscriptionAdapter = {
  prepare(ctx: SubscriptionDispatchContext): SubscriptionPreparedRequest | null {
    const { credential, surface } = ctx;
    if (!credential.ok) return null;

    const headers: Record<string, string> = { Originator: CODEX_ORIGINATOR };
    if (credential.accountId) headers['chatgpt-account-id'] = credential.accountId;

    // Responses-surface only: ensure the `instructions` field exists. The
    // chat_completions wire shape has no instructions field and is untouched.
    let body: Record<string, unknown> | null = null;
    if (surface === 'responses'
      && (ctx.body.instructions === undefined || ctx.body.instructions === null)) {
      body = { ...ctx.body, instructions: '' };
    }
    return { headers, body };
  },

  quotaResetHint(failure: SubscriptionFailureView, now: number): number | null {
    if (failure.status !== 429) return null;
    const resetAt = hintFromResetHeaders(failure.headers, CODEX_RESET_HEADERS, now)
      ?? hintFromResetBody(failure.body, CODEX_RESET_BODY_FIELDS);
    const relative = hintFromSecondsHeaders(failure.headers, CODEX_RESET_HEADERS);
    return capHint(resetAt, relative, now);
  },

  async discoverModels(credential: ResolvedSubscriptionCredential, _env: Record<string, unknown>): Promise<readonly string[] | null> {
    if (!credential.ok) return null;
    // The subscription's api.openai.com model catalog with the same identity
    // headers a shaped dispatch would send. Best-effort diagnostics: the
    // node's static models mapping stays the routing authority.
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/models', {
        headers: {
          Authorization: `Bearer ${credential.token}`,
          ...(credential.accountId ? { 'chatgpt-account-id': credential.accountId } : {}),
          Originator: CODEX_ORIGINATOR,
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
