// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
import type { ExecutionSurface } from '../contracts/execution.ts';
import type { IrProtocol } from './ir.ts';

export function protocolForSurface(surface: ExecutionSurface): IrProtocol | null {
  switch (surface) {
    case 'chat_completions':
      return 'openai_chat';
    case 'responses':
      return 'openai_responses';
    case 'messages':
      return 'anthropic';
    default:
      return null;
  }
}
