// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { Surface } from '../types/protocol.ts';
import type { ProviderAdapter, ProviderWire } from './types.ts';

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
