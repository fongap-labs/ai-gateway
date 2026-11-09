// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Canonical runtime-neutral protocol vocabulary for all applications.
// The former src/types/protocol.ts is a compatibility export.

export type Protocol = 'openai' | 'anthropic';

/**
 *   chat_completions  -> openai /v1/chat/completions
 *   responses         -> openai /v1/responses
 *   messages          -> anthropic /v1/messages
 */
export type Surface = import('./execution.ts').ExecutionSurface;
