// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// OpenAI provider adapter: native wire (Chat Completions + Responses),
// first-party OAuth onboarding defaults (public constants from the
// open-source Codex CLI), and the Codex subscription request semantics
// owned by src/subscription/openai.ts.

import { codexSubscriptionAdapter } from '../subscription/openai.ts';
import type { Surface } from '../types/protocol.ts';
import type { ProviderAdapter, ProviderWire, OAuthProviderConfig } from './types.ts';

const OPENAI_NATIVE_WIRE: ProviderWire = Object.freeze({
  protocol: 'openai',
  surfaces: Object.freeze(['chat_completions', 'responses'] as Surface[]),
});

const OPENAI_OAUTH_DEFAULTS: OAuthProviderConfig = Object.freeze({
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  scope: 'openid email profile offline_access',
  upstreamHeaders: Object.freeze({}),
});

export const openAIProviderAdapter: ProviderAdapter = Object.freeze({
  id: 'openai',
  wire: OPENAI_NATIVE_WIRE,
  streamUsage: true,
  oauth: OPENAI_OAUTH_DEFAULTS,
  subscription: codexSubscriptionAdapter,
});
