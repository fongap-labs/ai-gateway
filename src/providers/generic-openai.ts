// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// The generic OpenAI-compatible adapter: the registry fallback for every
// provider that has no adapter of its own. Any provider speaking the
// OpenAI-compatible Chat Completions wire works by configuration only -
// provider, base_url, credential, models - with zero source changes.

import type { ProviderAdapter, ProviderWire } from './types.ts';
import type { Surface } from '../types/protocol.ts';

export const GENERIC_OPENAI_ADAPTER_ID = 'generic-openai';

const GENERIC_OPENAI_WIRE: ProviderWire = Object.freeze({
  protocol: 'openai',
  surfaces: Object.freeze(['chat_completions'] as Surface[]),
});

export const genericOpenAIProviderAdapter: ProviderAdapter = Object.freeze({
  id: GENERIC_OPENAI_ADAPTER_ID,
  wire: GENERIC_OPENAI_WIRE,
  streamUsage: true,
});
