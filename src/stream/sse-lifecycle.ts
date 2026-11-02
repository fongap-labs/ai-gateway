// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Bounded protocol-aware observation of Server-Sent Events. The observer never
// changes the bytes sent to the client. It only recognizes complete SSE frames,
// terminal protocol events, and provider-reported usage.

import { mergeReportedUsage, normalizeTokenUsage } from '../observability/token-usage.ts';

export type SseProtocol = 'openai_chat' | 'openai_responses' | 'anthropic';
export type SseTerminal = 'success' | 'failure' | null;

const MAX_LINE_CHARS = 64 * 1024;
const MAX_FRAME_CHARS = 64 * 1024;
const MAX_DECODE_BYTES = 16 * 1024;

export class SseLifecycleObserver {
  private lineBuffer = '';
  private eventName = '';
  private dataLines: string[] = [];
  private frameChars = 0;
  private overflowedFrame = false;
  private _observationTruncated = false;
  private _incompleteResponse = false;
  private _malformedEvent = false;
  private _bytesAfterTerminal = false;
  private readonly protocol: SseProtocol;
  private readonly strictDataValidation: boolean;
  private _terminal: SseTerminal = null;
  private _usage: unknown = null;
  private _unsafeToolUse = false;
  private readonly byteDecoder = new TextDecoder();

  constructor(protocol: SseProtocol, options: { strictDataValidation?: boolean } = {}) {
    this.protocol = protocol;
    this.strictDataValidation = options.strictDataValidation === true;
  }

  get terminal(): SseTerminal {
    return this._terminal;
  }

  get usage(): unknown {
    return this._usage;
  }

  get unsafeToolUse(): boolean {
    return this._unsafeToolUse;
  }

  get observationTruncated(): boolean {
    return this._observationTruncated;
  }

  get incompleteResponse(): boolean {
    return this._incompleteResponse;
  }

  get malformedEvent(): boolean {
    return this._malformedEvent;
  }

  get bytesAfterTerminal(): boolean {
    return this._bytesAfterTerminal;
  }

  noteTrailingBytes(): void {
    this._bytesAfterTerminal = true;
  }

  pushBytes(bytes: Uint8Array): void {
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_DECODE_BYTES) {
      this.push(this.byteDecoder.decode(bytes.subarray(offset, offset + MAX_DECODE_BYTES), { stream: true }));
    }
  }

  finishBytes(): void {
    this.push(this.byteDecoder.decode());
    this.flush();
  }

  push(text: string): void {
    if (!text) return;
    if (this._terminal) {
      this._bytesAfterTerminal = true;
      return;
    }
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      if (newline < 0) {
        const tailChars = text.length - offset;
        if (this.lineBuffer.length + tailChars > MAX_LINE_CHARS) {
          this.lineBuffer = '';
          this.dropFrame();
        } else this.lineBuffer += text.slice(offset);
        return;
      }
      const lineChars = newline - offset;
      if (this.lineBuffer.length + lineChars > MAX_LINE_CHARS) {
        this.lineBuffer = '';
        this.dropFrame();
      } else {
        let line = this.lineBuffer + text.slice(offset, newline);
        this.lineBuffer = '';
        if (line.endsWith('\r')) line = line.slice(0, -1);
        this.consumeLine(line);
      }
      if (this._terminal) {
        if (newline + 1 < text.length) this._bytesAfterTerminal = true;
        return;
      }
      offset = newline + 1;
    }
  }

  flush(): void {
    if (this._terminal) return;
    if (this.lineBuffer) this.consumeLine(this.lineBuffer.replace(/\r$/, ''));
    this.lineBuffer = '';
    this.dispatchFrame();
  }

  private dropFrame(): void {
    this._observationTruncated = true;
    this.eventName = '';
    this.dataLines = [];
    this.frameChars = 0;
    this.overflowedFrame = true;
  }

  private consumeLine(line: string): void {
    if (line.length > MAX_LINE_CHARS) {
      this.dropFrame();
      return;
    }
    if (line === '') {
      this.dispatchFrame();
      return;
    }
    if (line.startsWith(':') || this.overflowedFrame) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const rawValue = colon < 0 ? '' : line.slice(colon + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    this.frameChars += line.length;
    if (this.frameChars > MAX_FRAME_CHARS) {
      this.dropFrame();
      return;
    }
    if (field === 'event') this.eventName = value.slice(0, 256);
    else if (field === 'data') this.dataLines.push(value);
  }

  private dispatchFrame(): void {
    if (this.overflowedFrame) {
      this.eventName = '';
      this.dataLines = [];
      this.frameChars = 0;
      this.overflowedFrame = false;
      return;
    }
    const eventName = this.eventName;
    const data = this.dataLines.join('\n');
    this.eventName = '';
    this.dataLines = [];
    this.frameChars = 0;
    if (!eventName && !data) return;

    const eventFailure = eventName === 'error' || eventName === 'response.failed' || eventName === 'response.incomplete';
    const eventSuccess =
      (this.protocol === 'openai_responses' && eventName === 'response.completed') || (this.protocol === 'anthropic' && eventName === 'message_stop');
    if (this.protocol === 'openai_chat' && data.trim() === '[DONE]') {
      this._terminal = 'success';
      return;
    }

    const inspectData = this.strictDataValidation || shouldInspectFrame(this.protocol, eventName, data);
    if (data && data.length <= MAX_FRAME_CHARS && data.trim() !== '[DONE]' && inspectData) {
      try {
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (payload && typeof payload === 'object') {
          this._unsafeToolUse ||= containsToolInvocation(payload);
          this._incompleteResponse ||= containsIncompleteResponse(payload);
          const reported =
            payload.response && typeof payload.response === 'object' && 'usage' in payload.response
              ? (payload.response as Record<string, unknown>).usage
              : payload.message && typeof payload.message === 'object' && 'usage' in payload.message
                ? (payload.message as Record<string, unknown>).usage
                : payload.usage;
          if (reported !== undefined) {
            const merged = mergeReportedUsage(this._usage, reported);
            if (normalizeTokenUsage(merged)) this._usage = merged;
          }
        }
        if (payload && typeof payload === 'object' && payload.error != null) this._terminal = 'failure';
        if (this.protocol === 'openai_responses') {
          const response = payload.response;
          if (response && typeof response === 'object') {
            const status = (response as Record<string, unknown>).status;
            if (status === 'failed' || status === 'incomplete') this._terminal = 'failure';
          }
        }
      } catch {
        // Malformed provider frames are relayed as-is but cannot support cache replay.
        this._malformedEvent = true;
      }
    } else if (this.strictDataValidation && data && data.trim() === '[DONE]' && this.protocol !== 'openai_chat') {
      this._malformedEvent = true;
    }
    if (eventFailure) this._terminal = 'failure';
    else if (eventSuccess && this._terminal !== 'failure') {
      if (this.strictDataValidation && (!data || data.trim() === '[DONE]' || !inspectData)) this._malformedEvent = true;
      this._terminal = 'success';
    }
  }
}

function shouldInspectFrame(protocol: SseProtocol, eventName: string, data: string): boolean {
  if (
    eventName === 'error' ||
    eventName === 'response.completed' ||
    eventName === 'response.failed' ||
    eventName === 'response.incomplete' ||
    eventName === 'message_start' ||
    eventName === 'message_delta' ||
    eventName === 'message_stop'
  )
    return true;
  if (protocol === 'openai_responses' && /^(?:response\.(?:output_text|reasoning_text|refusal|content_part)\.)/.test(eventName)) return false;
  return /"(?:usage|error|tool_calls|function_call|tool_use|computer_call|finish_reason|stop_reason|incomplete_details|failed|incomplete|length|max_tokens|content_filter)"/i.test(
    data,
  );
}

function containsToolInvocation(value: unknown, key = ''): boolean {
  if (/^(?:tool_calls|function_call|tool_use|computer_call)$/i.test(key)) return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => containsToolInvocation(entry));
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:finish_reason|stop_reason)$/i.test(childKey) && /^(?:tool_calls|function_call|tool_use)$/i.test(String(childValue))) return true;
    if (/^type$/i.test(childKey) && /^(?:function_call|tool_use|computer_call)$/i.test(String(childValue))) return true;
    if (containsToolInvocation(childValue, childKey)) return true;
  }
  return false;
}

function containsIncompleteResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsIncompleteResponse);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:finish_reason|stop_reason)$/i.test(key) && /^(?:length|content_filter|max_tokens)$/i.test(String(child))) return true;
    if (containsIncompleteResponse(child)) return true;
  }
  return false;
}
