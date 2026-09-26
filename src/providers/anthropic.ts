// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Anthropic provider adapter: native Messages wire, first-party OAuth
// onboarding defaults (public constants from the open-source Claude Code
// CLI), and the Claude subscription request semantics owned by
// src/subscription/anthropic.ts.

import { claudeSubscriptionAdapter } from '../subscription/anthropic.ts';
import type { Surface } from '../types/protocol.ts';
import type { ProviderAdapter, ProviderWire, OAuthProviderConfig } from './types.ts';

const ANTHROPIC_NATIVE_WIRE: ProviderWire = Object.freeze({
  protocol: 'anthropic',
  surfaces: Object.freeze(['messages'] as Surface[]),
});

const ANTHROPIC_OAUTH_DEFAULTS: OAuthProviderConfig = Object.freeze({
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  upstreamHeaders: Object.freeze({}),
});

export const anthropicProviderAdapter: ProviderAdapter = Object.freeze({
  id: 'anthropic',
  wire: ANTHROPIC_NATIVE_WIRE,
  streamUsage: false,
  oauth: ANTHROPIC_OAUTH_DEFAULTS,
  subscription: claudeSubscriptionAdapter,
});
