// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Canonical intermediate representation (IR) for cross-protocol translation.
//
// The new conversion matrix (Chat / Responses / Messages mutual translation)
// is relational, not pairwise: every client protocol is PARSED into this IR,
// every upstream protocol is BUILT from it; every upstream stream is DECODED
// into IR events and encoded back into each client protocol. N protocols give
// N parse/build/decode/encode adapters instead of N*(N-1) direct translators
// (the same hub shape magpie ships; see yetone/magpie internal/gateway/ir.go).
//
// The IR is intentionally small. It models exactly the cross-protocol
// portable surface: plain text, images, function tools/calls/results,
// reasoning (thinking) parts with optional thinking level, sampling stops and
// usage. Everything beyond that belongs to ONE protocol and stays native.
//
// No client-controlled text may ever appear in diagnostics - only the fixed
// feature/action vocabulary defined in ../result.ts.

export type IrProtocol = 'openai_chat' | 'openai_responses' | 'anthropic';

// Canonical stop values (magpie's `"stop"|"length"|"tool"|"filter"`).
export type IrStop = '' | 'stop' | 'length' | 'tool' | 'filter';

// Canonical thinking level. Anthropic budget_tokens and OpenAI reasoning
// effort both normalize into this vocabulary; unknown levels never guess.
export type IrEffort = 'low' | 'medium' | 'high' | 'max';

export type IrImagePart = {
  type: 'image';
  url: string;
  mediaType?: string;
  data?: string; // base64 payload when the image was inline (`data:` / base64)
};

/** Inline document (PDF and the like) attached by the client; carried only as base64. */
export type IrDocumentPart = {
  type: 'document';
  mediaType: string;
  data: string;
  filename?: string;
};

export type IrToolCallPart = {
  type: 'tool_call';
  id: string;
  name: string;
  /** Raw JSON-encoded arguments string, exactly as the wire carried it. */
  args: string;
};

export type IrToolResultPart = {
  type: 'tool_result';
  callId: string;
  text: string;
  isError?: boolean;
  images: IrImagePart[];
  documents?: IrDocumentPart[];
};

export type IrThinkingPart = {
  type: 'thinking';
  text: string;
  /** Provider thinking signature when the origin preserved one. */
  signature?: string;
  /** True when the part stood for an opaque sealed/redacted thinking block whose text was dropped. */
  sealed?: boolean;
  /** Raw provider payload for sealed blocks (Anthropic `redacted_thinking` data, Responses encrypted_content). */
  data?: string;
};

export type IrPart = { type: 'text'; text: string } | IrImagePart | IrDocumentPart | IrToolCallPart | IrToolResultPart | IrThinkingPart;

/** `stringContent` marks a user message whose source content was a plain string (kept a string on the wire). */
export type IrMessage = { role: 'user' | 'assistant' | 'system'; parts: IrPart[]; stringContent?: boolean };

export type IrTool = { name: string; description?: string; schema: unknown; strict?: boolean };

/**
 * ToolChoice is normalized to one of: undefined (unset), "auto", "none",
 * "required", "name:<tool>".
 */
export type IrToolChoice = 'auto' | 'none' | 'required' | `name:${string}`;

export type IrRequest = {
  model: string;
  /** System text segments in source order: one per system/developer item or top-level system. */
  system: string[];
  messages: IrMessage[];
  tools: IrTool[];
  toolChoice?: IrToolChoice;
  parallelToolCalls?: boolean | null;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  stop: string[];
  /** Thinking level; null means the client did not ask for reasoning. */
  effort?: IrEffort | null;
  /** Schema-driven structured output, translated conservatively (prompt). */
  structuredOutputSchema?: Record<string, unknown> | null;
};

// ---- Streaming events ------------------------------------------------------

export type IrEvent =
  | { type: 'start'; id: string; model: string; inputTokens?: number }
  | { type: 'text'; text: string }
  | { type: 'think'; text: string }
  | { type: 'sig'; signature: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_args'; args: string }
  | { type: 'stop'; stop: IrStop }
  | { type: 'usage'; raw: unknown }
  | { type: 'sealed'; text: string }
  | { type: 'error'; message: string };

/** The completed translation of one upstream reply stream. */
export type IrReply = {
  id: string;
  model: string;
  parts: IrPart[];
  stop: IrStop;
  /** Raw usage object exactly as the upstream reported it. */
  rawUsage: unknown;
  inputTokens: number;
};

/** Assembles IrEvents into an IrReply (shared by streaming/object paths). */
export class IrCollector {
  id = '';
  model = '';
  parts: IrPart[] = [];
  stop: IrStop = '';
  rawUsage: unknown = null;
  inputTokens = 0;
  // mutable tail state for streaming assembly
  private openKind: 'text' | 'think' | null = null;

  feed(event: IrEvent): void {
    switch (event.type) {
      case 'start': {
        this.id = event.id || this.id;
        this.model = event.model || this.model;
        this.inputTokens = event.inputTokens ?? this.inputTokens;
        return;
      }
      case 'text': {
        if (!event.text) return;
        this.pushMerged('text', event.text);
        this.openKind = 'text';
        return;
      }
      case 'think': {
        if (!event.text) return;
        this.pushMerged('thinking', event.text);
        this.openKind = 'think';
        return;
      }
      case 'sig': {
        // Attach the signature to a STILL-OPEN thinking part only - matching
        // the Anthropic stream lifecycle where signature_delta closes a block.
        const tail = this.parts[this.parts.length - 1];
        if (this.openKind === 'think' && tail && tail.type === 'thinking')
          tail.signature = tail.signature ? `${tail.signature}${event.signature}` : event.signature;
        return;
      }
      case 'sealed': {
        // Opaque encrypted thinking has no portable representation on Chat /
        // Responses. The raw payload is retained on the marked part so an
        // Anthropic client can still receive `redacted_thinking` verbatim;
        // other clients drop it and report diagnostics at build time.
        this.parts.push(event.text ? { type: 'thinking', text: '', sealed: true, data: event.text } : { type: 'thinking', text: '', sealed: true });
        this.openKind = null;
        return;
      }
      case 'tool_start': {
        this.openKind = null;
        this.parts.push({ type: 'tool_call', id: event.id, name: event.name, args: '' });
        return;
      }
      case 'tool_args': {
        const tail = this.parts[this.parts.length - 1];
        if (tail && tail.type === 'tool_call') tail.args += event.args;
        // An args fragment without an open call is dropped silently: the
        // stream reorder case never survives translation losslessly.
        return;
      }
      case 'stop': {
        this.stop = event.stop;
        return;
      }
      case 'usage': {
        this.rawUsage = event.raw;
        return;
      }
      default:
        return;
    }
  }

  private pushMerged(type: 'text' | 'thinking', text: string): void {
    const tail = this.parts[this.parts.length - 1];
    if (tail && this.openKind === type && tail.type === type) {
      tail.text = `${tail.text}${text}`;
      return;
    }
    if (type === 'thinking') this.parts.push({ type: 'thinking', text });
    else this.parts.push({ type: 'text', text });
  }

  finish(idFallback: string): IrReply {
    if (!this.id) this.id = idFallback;
    return { id: this.id, model: this.model, parts: this.parts, stop: this.stop, rawUsage: this.rawUsage, inputTokens: this.inputTokens };
  }
}

// ---- Thinking level mapping ------------------------------------------------
//
// effort <-> Anthropic thinking budget_tokens, and effort <- budget inverse.
// Values follow the magpie mapping (4096 / 10000 / 24000 / 32000); the
// inverse grading is documented so a translated budget stays stable across
// round trips at the effort grain.

export const EFFORT_BUDGET: Readonly<Record<IrEffort, number>> = Object.freeze({ low: 4096, medium: 10000, high: 24000, max: 32000 });

/** Anthropic requires reasoning requests to leave answer-token headroom. */
export const THINKING_HEADROOM = 1024;

export function effortToBudget(effort: IrEffort): number {
  return EFFORT_BUDGET[effort];
}

export function budgetToEffort(budget: number): IrEffort {
  if (budget <= EFFORT_BUDGET.low) return 'low';
  if (budget <= 12000) return 'medium';
  if (budget <= EFFORT_BUDGET.high) return 'high';
  return 'max';
}

/** OpenAI Chat/Responses effort vocabulary -> canonical level. */
export function normalizeEffort(value: unknown): IrEffort | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'none') return null; // explicitly disabled
  if (typeof value !== 'string') return undefined;
  switch (value) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
      return 'max';
    default:
      return undefined;
  }
}

// ---- Shared value helpers --------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function isIrToolCall(part: IrPart): part is IrToolCallPart {
  return part.type === 'tool_call';
}

export function isIrToolResult(part: IrPart): part is IrToolResultPart {
  return part.type === 'tool_result';
}

export function isIrThinking(part: IrPart): part is IrThinkingPart {
  return part.type === 'thinking';
}

export function replyHasMeaningfulOutput(reply: IrReply): boolean {
  return reply.parts.some((p) => {
    if (p.type === 'text' && p.text.trim()) return true;
    if (p.type === 'thinking' && p.text.trim()) return true;
    if (p.type === 'tool_call') return true;
    return false;
  });
}
