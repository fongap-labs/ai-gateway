// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs

export type IrProtocol = 'openai_chat' | 'openai_responses' | 'anthropic';

export type IrStop = '' | 'stop' | 'length' | 'tool' | 'filter';

export type IrEffort = 'low' | 'medium' | 'high' | 'max';

export type IrImagePart = {
  type: 'image';
  url: string;
  mediaType?: string;
  data?: string;
};

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
  signature?: string;
  sealed?: boolean;
  data?: string;
};

export type IrPart = { type: 'text'; text: string } | IrImagePart | IrDocumentPart | IrToolCallPart | IrToolResultPart | IrThinkingPart;

const DATA_URL_IMAGE = /^data:([^;,]+)(;base64)?,(.*)$/s;

export function inlineDataUrlImage(url: string): IrImagePart {
  const match = DATA_URL_IMAGE.exec(url);
  if (!match) return { type: 'image', url };
  const mediaType = match[1] ?? 'image/png';
  if (match[2]) {
    const data = decodeURIComponentSafe(match[3] ?? '');
    if (data) return { type: 'image', url, mediaType, data };
  }
  return { type: 'image', url };
}

function decodeURIComponentSafe(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export type IrMessage = { role: 'user' | 'assistant' | 'system'; parts: IrPart[]; stringContent?: boolean };

export type IrTool = { name: string; description?: string; schema: unknown; strict?: boolean };

export type IrToolChoice = 'auto' | 'none' | 'required' | `name:${string}`;

export type IrRequest = {
  model: string;
  system: string[];
  messages: IrMessage[];
  tools: IrTool[];
  toolChoice?: IrToolChoice;
  parallelToolCalls?: boolean | null;
  maxTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  stop: string[];
  effort?: IrEffort | null;
  structuredOutputSchema?: Record<string, unknown> | null;
};

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

export type IrReply = {
  id: string;
  model: string;
  parts: IrPart[];
  stop: IrStop;
  rawUsage: unknown;
  inputTokens: number;
};

export class IrCollector {
  id = '';
  model = '';
  parts: IrPart[] = [];
  stop: IrStop = '';
  rawUsage: unknown = null;
  inputTokens = 0;
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
        const tail = this.parts[this.parts.length - 1];
        if (this.openKind === 'think' && tail && tail.type === 'thinking')
          tail.signature = tail.signature ? `${tail.signature}${event.signature}` : event.signature;
        return;
      }
      case 'sealed': {
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
    return {
      id: this.id,
      model: this.model,
      parts: this.parts,
      stop: stopWithToolCalls(this.stop, this.parts),
      rawUsage: this.rawUsage,
      inputTokens: this.inputTokens,
    };
  }
}

export function stopWithToolCalls(stop: IrStop, parts: readonly IrPart[]): IrStop {
  return stop === 'stop' && parts.some((part) => part.type === 'tool_call') ? 'tool' : stop;
}

export const EFFORT_BUDGET: Readonly<Record<IrEffort, number>> = Object.freeze({ low: 4096, medium: 10000, high: 24000, max: 32000 });

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

export function normalizeEffort(value: unknown): IrEffort | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'none') return null;
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
