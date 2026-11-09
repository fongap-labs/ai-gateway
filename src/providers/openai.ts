// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// OpenAI provider adapter: native Chat Completions and Responses protocol.
import type { Surface } from '../types/protocol.ts';
import type { ProviderAdapter, ProviderWire } from './types.ts';

const OPENAI_NATIVE_WIRE: ProviderWire = Object.freeze({
  protocol: 'openai',
  surfaces: Object.freeze(['chat_completions', 'responses'] as Surface[]),
});

export const openAIProviderAdapter: ProviderAdapter = Object.freeze({
  id: 'openai',
  wire: OPENAI_NATIVE_WIRE,
  streamUsage: true,
});
