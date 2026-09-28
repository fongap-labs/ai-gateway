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

import type { Protocol, Surface } from '../types/protocol.ts';
import {
  ANTHROPIC_SURFACE_PATH,
  buildAnthropicHeaders,
  isAnthropicMessageMeaningful,
  isAnthropicNativeRealOutput,
  isAnthropicNativeRealOutputForConversion,
  resolveAnthropicPath,
} from './anthropic.ts';
import {
  buildOpenAIHeaders,
  isOpenAIChatCompletionMeaningful,
  isOpenAIChatRealOutput,
  isOpenAIChatRealOutputForConversion,
  isOpenAIResponsesObjectMeaningful,
  isResponsesRealOutput,
  OPENAI_SURFACE_PATH,
  resolveOpenAIPath,
} from './openai.ts';

export { isOpenAIStreamingResponse, withUsageStreamOptions } from '../protocol/openai.ts';
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

// Protocol-aware upstream headers. Client auth material never reaches the
// upstream for either protocol; the node credential is applied in the
// protocol's native auth header shape. `options.auth === 'oauth'` switches
// the Anthropic shape from x-api-key to Bearer for subscription nodes, and
// `options.extraHeaders` applies deployment-owned subscription headers.
export function buildUpstreamHeadersFor(
  protocol: Protocol,
  request: Request,
  credential: string,
  requestId: string,
  options?: { auth?: 'oauth'; extraHeaders?: Readonly<Record<string, string>> },
): Headers {
  switch (protocol) {
    case 'openai':
      return buildOpenAIHeaders(request, credential, requestId, options?.extraHeaders);
    case 'anthropic':
      return buildAnthropicHeaders(request, credential, requestId, options);
    default:
      throw new Error(`unknown protocol: ${protocol}`);
  }
}
