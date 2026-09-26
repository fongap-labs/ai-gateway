// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Google provider adapter. The wire contract is OpenAI-compatible Chat
// Completions (the public Generative Language API shape). OAuth
// onboarding uses the Gemini CLI's public constants and the manual
// code-paste flow (its OAuth client does not allow arbitrary gateway
// redirect URIs). No verified Gemini/Code Assist subscription backend
// exists behind this wire, so the composed subscription adapter refuses
// to shape requests and dispatch fails closed.

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
  subscription: googleSubscriptionAdapter,
});
