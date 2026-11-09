// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Unified provider adapter contract.
//
// The adapter describes the upstream protocol, surfaces and native image support.
// Tier 2 uses static API Tokens only; no subscriber OAuth integration.
//
// Adding a plain OpenAI-compatible provider needs no source change at all
// (the generic-openai adapter is the registry fallback).

import type { Protocol, Surface } from '../types/protocol.ts';
import type { ImageGenerationAdapter } from './image-generation.ts';

/** Structural wire contract: which protocol the provider speaks and which
 *  upstream surfaces are routable. This is provider knowledge, not
 *  per-account configuration; node records cannot override it. */
export type ProviderWire = Readonly<{
  protocol: Protocol;
  surfaces: ReadonlyArray<Surface>;
}>;

export type ProviderAdapter = Readonly<{
  /** Registry key: the provider name used in node configuration. */
  id: string;
  wire: ProviderWire;
  /** Whether this provider's OpenAI chat_completions stream accepts the
   *  passive `stream_options.include_usage` hint in auto mode. Operator
   *  switches (AIG_USAGE_INCLUDE_MODE / AIG_USAGE_EXCLUDE_PROVIDERS) still
   *  apply on top of this declaration. */
  streamUsage: boolean;
  /** Native image-generation wire contract, absent for chat-only providers. */
  image?: ImageGenerationAdapter;
}>;
