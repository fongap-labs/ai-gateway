// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Anthropic provider adapter: native Messages protocol.
import type { Surface } from '../types/protocol.ts';
import type { ProviderAdapter, ProviderWire } from './types.ts';

const ANTHROPIC_NATIVE_WIRE: ProviderWire = Object.freeze({
  protocol: 'anthropic',
  surfaces: Object.freeze(['messages'] as Surface[]),
});

export const anthropicProviderAdapter: ProviderAdapter = Object.freeze({
  id: 'anthropic',
  wire: ANTHROPIC_NATIVE_WIRE,
  streamUsage: false,
});
