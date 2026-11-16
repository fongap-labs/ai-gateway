// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
import type { Surface } from '../types/protocol.ts';
import type { ProviderAdapter, ProviderWire } from './types.ts';

const GOOGLE_WIRE: ProviderWire = Object.freeze({
  protocol: 'openai',
  surfaces: Object.freeze(['chat_completions'] as Surface[]),
});

export const googleProviderAdapter: ProviderAdapter = Object.freeze({
  id: 'google',
  wire: GOOGLE_WIRE,
  streamUsage: true,
});
