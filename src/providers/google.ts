// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Google provider adapter. The wire contract (client-facing) is
// OpenAI-compatible Chat Completions; OAuth onboarding uses the Gemini
// CLI's public constants and the manual code-paste flow (its OAuth client
// does not allow arbitrary gateway redirect URIs). The subscription
// entitlement is served by the Cloud Code Assist backend
// (cloudcode-pa.googleapis.com/v1internal), whose proprietary wire
// (generateContent / streamGenerateContent) is owned by the composed
// subscription adapter through src/subscription/google-wire.ts. The
// proprietary wire never enters the gateway's general transport or
// conversion layers; it is converted to/from the OpenAI Chat surface inside
// the subscription adapter and the dispatch layer.

import { googleSubscriptionAdapter } from '../subscription/google.ts';
import type { Surface } from '../types/protocol.ts';
import type { ProviderAdapter, ProviderWire, OAuthProviderConfig } from './types.ts';

const GOOGLE_WIRE: ProviderWire = Object.freeze({
  protocol: 'openai',
  surfaces: Object.freeze(['chat_completions'] as Surface[]),
});

const GOOGLE_OAUTH_DEFAULTS: OAuthProviderConfig = Object.freeze({
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret: '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',
  scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs',
  manualRedirectUrl: 'https://codeassist.google.com/authcode',
  upstreamHeaders: Object.freeze({}),
});

export const googleProviderAdapter: ProviderAdapter = Object.freeze({
  id: 'google',
  wire: GOOGLE_WIRE,
  streamUsage: true,
  oauth: GOOGLE_OAUTH_DEFAULTS,
  subscriptionEndpoint: 'https://cloudcode-pa.googleapis.com',
  subscription: googleSubscriptionAdapter,
});
