// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Transport layer - protocol-aware upstream plumbing.
//
//   Client surface -> (protocol, surface) -> Transport -> native upstream path
//
// The transport decides: upstream path, upstream headers, protocol-specific
// stream semantics and response handling. It NEVER decides scheduling,
// cooldowns, circuit state, hedges or failover budgets - those stay in
// src/scheduler / src/reliability and are protocol-agnostic.
//
// Exactly two protocol families exist:
//   openai    -> chat_completions, responses
//   anthropic -> messages

import {
  ANTHROPIC_SURFACE_PATH,
  buildAnthropicHeaders,
  isAnthropicMessageMeaningful,
  isAnthropicNativeRealOutput,
  isAnthropicNativeRealOutputForConversion,
  resolveAnthropicPath,
} from './anthropic-native.ts';
import {
  buildOpenAIHeaders,
  isOpenAIChatCompletionMeaningful,
  isOpenAIChatRealOutput,
  isOpenAIChatRealOutputForConversion,
  isOpenAIResponsesObjectMeaningful,
  isResponsesRealOutput,
  OPENAI_SURFACE_PATH,
  resolveOpenAIPath,
} from './openai-native.ts';
import type { Protocol, Surface } from '../contracts/protocol.ts';

export { isOpenAIStreamingResponse, withUsageStreamOptions } from '../protocol-core/openai.ts';
export {
  ANTHROPIC_SURFACE_PATH,
  buildAnthropicHeaders,
  buildOpenAIHeaders,
  isAnthropicMessageMeaningful,
  isAnthropicNativeRealOutput,
  isAnthropicNativeRealOutputForConversion,
  isOpenAIChatCompletionMeaningful,
  isOpenAIChatRealOutput,
  isOpenAIChatRealOutputForConversion,
  isOpenAIResponsesObjectMeaningful,
  isResponsesRealOutput,
  OPENAI_SURFACE_PATH,
  resolveAnthropicPath,
  resolveOpenAIPath,
};

// The upstream path for a (protocol, surface) pair. Both must be valid: the
// config layer already validated node.protocol / node.surfaces, and the
// request handler derives the surface from the route, so an unknown pair is
// an internal invariant break - fail loudly instead of guessing a path.
export function resolveUpstreamPath(protocol: Protocol, surface: Surface): string {
  switch (protocol) {
    case 'openai':
      return resolveOpenAIPath(surface);
    case 'anthropic':
      return resolveAnthropicPath(surface);
    default:
      throw new Error(`unknown protocol: ${protocol}`);
  }
}

// Protocol-native upstream headers always use static API Tokens.
export function buildUpstreamHeadersFor(protocol: Protocol, request: Request, credential: string, requestId: string): Headers {
  switch (protocol) {
    case 'openai':
      return buildOpenAIHeaders(request, credential, requestId);
    case 'anthropic':
      return buildAnthropicHeaders(request, credential, requestId);
    default:
      throw new Error(`unknown protocol: ${protocol}`);
  }
}
