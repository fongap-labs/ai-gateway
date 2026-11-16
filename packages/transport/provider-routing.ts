// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

import type { Protocol, Surface } from '../contracts/protocol.ts';
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
