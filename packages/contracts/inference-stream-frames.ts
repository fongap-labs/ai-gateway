// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Private binary framing for cross-center translated SSE. The Gateway MUST
// decode this before returning a public Response: raw usage and budget status
// are control frames, never client SSE bytes.
import type { BudgetStopReason } from '../conversion-core/budget.ts';

export const INFERENCE_FRAMED_STREAM_FORMAT = 'inference-framed-v1' as const;
export const INFERENCE_FRAMED_STREAM_CONTENT_TYPE = 'application/vnd.aig.inference-frames' as const;

const MAGIC = 0xa7;
const VERSION = 1;
const HEADER_BYTES = 7;
const MAX_CHUNK_BYTES = 16 * 1024;
const MAX_USAGE_BYTES = 8 * 1024;
const MAX_BUFFERED_BYTES = 256 * 1024;
const STOP_REASONS = new Set(['events', 'output_units', 'tool_events', 'tool_args', 'output_tokens']);

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

type FrameKind = 1 | 2 | 3 | 4;
type Frame =
  | { kind: 'chunk'; bytes: Uint8Array }
  | { kind: 'usage'; usage: Record<string, unknown> }
  | { kind: 'budget'; reason: BudgetStopReason }
  | { kind: 'done' };

function privateFrameError(): Error {
  return new Error('invalid private inference stream frame');
}

function encode(kind: FrameKind, payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_CHUNK_BYTES) throw privateFrameError();
  if (kind === 2 && payload.byteLength > MAX_USAGE_BYTES) throw privateFrameError();
  if (kind === 3 && payload.byteLength > 64) throw privateFrameError();
  if (kind === 4 && payload.byteLength !== 0) throw privateFrameError();
  const bytes = new Uint8Array(HEADER_BYTES + payload.byteLength);
  bytes[0] = MAGIC;
  bytes[1] = VERSION;
  bytes[2] = kind;
  new DataView(bytes.buffer).setUint32(3, payload.byteLength, false);
  bytes.set(payload, HEADER_BYTES);
  return bytes;
}

export function encodeInferenceFrame(frame: Frame): Uint8Array {
  switch (frame.kind) {
    case 'chunk':
      if (!(frame.bytes instanceof Uint8Array)) throw privateFrameError();
      return encode(1, frame.bytes);
    case 'usage': {
      if (!frame.usage || typeof frame.usage !== 'object' || Array.isArray(frame.usage)) throw privateFrameError();
      let data: string;
      try {
        data = JSON.stringify(frame.usage);
      } catch {
        throw privateFrameError();
      }
      return encode(2, encoder.encode(data));
    }
    case 'budget':
      if (!STOP_REASONS.has(frame.reason)) throw privateFrameError();
      return encode(3, encoder.encode(frame.reason));
    case 'done':
      return encode(4, new Uint8Array(0));
  }
}

function takeFrame(bytes: Uint8Array): { frame: Frame; length: number } | null {
  if (bytes.byteLength < HEADER_BYTES) return null;
  if (bytes[0] !== MAGIC || bytes[1] !== VERSION) throw privateFrameError();
  const kind = bytes[2];
  if (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4) throw privateFrameError();
  const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(3, false);
  if (size > MAX_CHUNK_BYTES || (kind === 2 && size > MAX_USAGE_BYTES) || (kind === 3 && size > 64) || (kind === 4 && size !== 0))
    throw privateFrameError();
  if (bytes.byteLength < HEADER_BYTES + size) return null;
  const data = bytes.slice(HEADER_BYTES, HEADER_BYTES + size);
  let frame: Frame;
  if (kind === 1) {
    if (size === 0) throw privateFrameError();
    frame = { kind: 'chunk', bytes: data };
  } else if (kind === 2) {
    let usage: unknown;
    try {
      usage = JSON.parse(decoder.decode(data));
    } catch {
      throw privateFrameError();
    }
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw privateFrameError();
    frame = { kind: 'usage', usage: usage as Record<string, unknown> };
  } else if (kind === 3) {
    const reason = decoder.decode(data);
    if (!STOP_REASONS.has(reason)) throw privateFrameError();
    frame = { kind: 'budget', reason: reason as BudgetStopReason };
  } else {
    frame = { kind: 'done' };
  }
  return { frame, length: HEADER_BYTES + size };
}

/**
 * Frame a converted SSE stream and its private raw-usage side channel without
 * buffering the full response. A conversion callback reports usage *during*
 * reads; its frames remain in order before the converted bytes from that read.
 */
export function frameInferenceStream(
  makeStream: (onUsage: (usage: unknown) => void) => ReadableStream<Uint8Array>,
  budgetStopped: () => BudgetStopReason | null = () => null,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const pending: Uint8Array[] = [];
  let isFinished = false;
  let frameFailure: Error | null = null;
  const onUsage = (usage: unknown): void => {
    if (usage == null) return;
    try {
      if (pending.length >= 128) throw privateFrameError();
      pending.push(encodeInferenceFrame({ kind: 'usage', usage: usage as Record<string, unknown> }));
    } catch {
      frameFailure = privateFrameError();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!reader) reader = makeStream(onUsage).getReader();
        for (;;) {
          if (frameFailure) throw frameFailure;
          const next = pending.shift();
          if (next) {
            controller.enqueue(next);
            return;
          }
          if (isFinished) {
            controller.close();
            return;
          }
          const result = await reader.read();
          if (result.done) {
            const reason = budgetStopped();
            if (reason !== null) pending.push(encodeInferenceFrame({ kind: 'budget', reason }));
            pending.push(encodeInferenceFrame({ kind: 'done' }));
            isFinished = true;
          } else {
            if (!(result.value instanceof Uint8Array)) throw privateFrameError();
            for (let offset = 0; offset < result.value.byteLength; offset += MAX_CHUNK_BYTES) {
              pending.push(encodeInferenceFrame({ kind: 'chunk', bytes: result.value.slice(offset, offset + MAX_CHUNK_BYTES) }));
            }
          }
        }
      } catch {
        await reader?.cancel().catch(() => {});
        controller.error(privateFrameError());
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Strip internal framing before Gateway's public first-output guard. Control
 * events are delivered to accounting callbacks only and can never become
 * client-visible SSE frames, including when a frame is malformed or truncated.
 */
export function unframeInferenceStream(
  source: ReadableStream<Uint8Array>,
  callbacks: { onUsage?: (usage: Record<string, unknown>) => void; onBudgetStop?: (reason: BudgetStopReason) => void } = {},
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let buffer = new Uint8Array(0);
  let hasDone = false;
  let hasBudget = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let work = 0;
        for (;;) {
          if (++work > 1024) throw privateFrameError();
          const parsed = takeFrame(buffer);
          if (parsed) {
            buffer = buffer.slice(parsed.length);
            if (hasDone) throw privateFrameError();
            if (parsed.frame.kind === 'done') {
              hasDone = true;
            } else if (parsed.frame.kind === 'usage') {
              callbacks.onUsage?.(parsed.frame.usage);
            } else if (parsed.frame.kind === 'budget') {
              if (hasBudget) throw privateFrameError();
              hasBudget = true;
              callbacks.onBudgetStop?.(parsed.frame.reason);
            } else {
              if (hasBudget) throw privateFrameError();
              controller.enqueue(parsed.frame.bytes);
              return;
            }
            continue;
          }
          const next = await reader.read();
          if (next.done) {
            if (!hasDone || buffer.byteLength > 0) throw privateFrameError();
            controller.close();
            return;
          }
          if (!(next.value instanceof Uint8Array) || buffer.byteLength + next.value.byteLength > MAX_BUFFERED_BYTES) throw privateFrameError();
          const combined = new Uint8Array(buffer.byteLength + next.value.byteLength);
          combined.set(buffer);
          combined.set(next.value, buffer.byteLength);
          buffer = combined;
        }
      } catch {
        await reader.cancel().catch(() => {});
        controller.error(privateFrameError());
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}
