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

import type { SubscriptionDispatchContext, SubscriptionPreparedRequest, SubscriptionAdapter } from './types.ts';

const CODEX_ORIGINATOR = 'codex-tui';

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
};
