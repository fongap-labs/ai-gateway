// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// SSE protocol framing and deadline primitives shared by Gateway commit
// guard and Inference conversion. No policy, Provider or node dependencies.

export const GUARD_ERROR = {
  TIMEOUT: 'first_event_timeout',
  EMPTY: 'empty_stream',
  DONE_ONLY: 'done_only_stream',
  ABORTED: 'client_aborted',
  MALFORMED: 'malformed_first_event',
  ERROR_ENVELOPE: 'first_event_error_envelope',
  PRE_EVENT_BYTES_EXCEEDED: 'first_event_pre_bytes_exceeded',
  SSE_LINE_EXCEEDED: 'first_event_sse_line_exceeded',
} as const;

export type GuardErrorCode = (typeof GUARD_ERROR)[keyof typeof GUARD_ERROR];

class GuardError extends Error {
  code: GuardErrorCode;
  constructor(code: GuardErrorCode) {
    super(code);
    this.name = 'FirstEventGuardError';
    this.code = code;
  }
}

export function guardError(code: GuardErrorCode): GuardError {
  return new GuardError(code);
}

export const FIRST_EVENT_MAX_SSE_LINE = 1024 * 1024;

export type SseEventState = { dataLines: string[]; dataLength: number };
export type SseEventHandler = (data: string) => void;

export function createSseScanner(onEvent: SseEventHandler): { push(chunkText: string): void; flush(): void } {
  let buffer = '';
  const eventState: SseEventState = { dataLines: [], dataLength: 0 };
  return {
    push(chunkText: string): void {
      buffer += chunkText;
      buffer = drainLines(buffer, eventState, onEvent);
      if (buffer.length > FIRST_EVENT_MAX_SSE_LINE) {
        throw guardError(GUARD_ERROR.SSE_LINE_EXCEEDED);
      }
    },
    flush(): void {
      buffer = drainLines(`${buffer}`, eventState, onEvent, true);
    },
  };
}

function drainLines(buffer: string, eventState: SseEventState, onEvent: SseEventHandler, shouldFlush: boolean = false): string {
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline < 0) break;
    let line = rest.slice(0, newline);
    rest = rest.slice(newline + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length > FIRST_EVENT_MAX_SSE_LINE) {
      throw guardError(GUARD_ERROR.SSE_LINE_EXCEEDED);
    }
    handleSseLine(line, eventState, onEvent);
  }
  if (shouldFlush) {
    let tail = rest;
    if (tail.endsWith('\r')) tail = tail.slice(0, -1);
    if (tail.length > FIRST_EVENT_MAX_SSE_LINE) {
      throw guardError(GUARD_ERROR.SSE_LINE_EXCEEDED);
    }
    if (tail) handleSseLine(tail, eventState, onEvent);
    dispatchData(eventState, onEvent);
    return '';
  }
  return rest;
}

function handleSseLine(line: string, eventState: SseEventState, onEvent: SseEventHandler): void {
  if (line === '') {
    dispatchData(eventState, onEvent);
    return;
  }
  if (line.charCodeAt(0) === 58) return;
  if (!line.startsWith('data:')) return;
  const value = line.slice(5).trimStart();
  if (eventState.dataLines.length > 0 && isCompletePayload(eventState.dataLines.join('\n'))) {
    dispatchData(eventState, onEvent);
  }
  const separatorLength = eventState.dataLines.length > 0 ? 1 : 0;
  if (eventState.dataLength + separatorLength + value.length > FIRST_EVENT_MAX_SSE_LINE) {
    throw guardError(GUARD_ERROR.SSE_LINE_EXCEEDED);
  }
  eventState.dataLines.push(value);
  eventState.dataLength += separatorLength + value.length;
}

function dispatchData(eventState: SseEventState, onEvent: SseEventHandler): void {
  const { dataLines } = eventState;
  if (dataLines.length === 0) return;
  const data = dataLines.join('\n');
  dataLines.length = 0;
  eventState.dataLength = 0;
  onEvent(data);
}

function isCompletePayload(data: string): boolean {
  if (!data || data === '[DONE]') return true;
  try {
    JSON.parse(data);
    return true;
  } catch {
    return false;
  }
}

export async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineMs: number | null | undefined,
  onDeadline: (message: string) => Promise<never>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const message = 'Attempt deadline reached while assembling the response body.';
  if (!deadlineMs || deadlineMs <= 0) return reader.read();
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return onDeadline(message);
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<'timeout'>((resolve) => {
    timerId = setTimeout(() => resolve('timeout'), remaining);
  });
  try {
    const result = await Promise.race([reader.read().then((v) => ({ chunk: v })), timeoutP.then(() => 'timeout' as const)]);
    if (result === 'timeout') return onDeadline(message);
    return result.chunk;
  } finally {
    clearTimeout(timerId);
  }
}
