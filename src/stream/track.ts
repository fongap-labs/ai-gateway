// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Tracked stream wrapper: relay, idle timeout, node outcome, optional model
// rewrite, and passive upstream-reported usage observation.

import { mergeReportedUsage, normalizeTokenUsage } from '../observability/token-usage.ts';
import { FIRST_EVENT_MAX_SSE_LINE } from './guard.ts';

const TRACK_MAX_LINE_BUFFER = FIRST_EVENT_MAX_SSE_LINE;

export type TrackStreamEndInfo = {
  reason: string | null;
  durationMs: number;
  chunkCount: number;
  receivedBytes: number;
  completionMarkerSeen: boolean;
};

export type TrackOptions = {
  idleTimeoutMs: number;
  onSuccess: () => void;
  onFailure: () => void;
  onNeutral: () => void;
  onStreamStart?: () => void;
  onStreamEnd?: (outcome: string, info: TrackStreamEndInfo) => void;
  completionMarker?: RegExp;
  closeMarker?: RegExp;
  completionGraceMs?: number;
  failureMarker?: RegExp;
  rewriteModel?: string;
  rewriteModelAt?: string;
  // Delivered-response usage callback. Preserved semantics: fires only for a
  // cleanly completed stream so model-status / delivered-token evidence cannot
  // be polluted by interrupted attempts.
  onUsage?: (usage: unknown) => void;
  // Physical-upstream accounting callback. Fires once for EVERY terminal stream
  // outcome and carries the best cumulative usage the upstream actually
  // reported, or null when no usable report was seen.
  onAttemptUsage?: (usage: unknown, outcome: 'success' | 'failure' | 'neutral') => void;
  interruptionChunk?: (reason: string | null, details?: { nextSequenceNumber?: number }) => Uint8Array;
  upstreamFailureReason?: () => string | null;
};

export function trackStreamResponse(
  response: Response,
  {
    idleTimeoutMs,
    onSuccess,
    onFailure,
    onNeutral,
    onStreamStart,
    onStreamEnd,
    completionMarker,
    closeMarker,
    completionGraceMs = 0,
    failureMarker,
    rewriteModel,
    rewriteModelAt,
    onUsage,
    onAttemptUsage,
    interruptionChunk,
    upstreamFailureReason,
  }: TrackOptions,
): Response {
  if (!response.body) {
    try {
      onAttemptUsage?.(null, 'success');
    } catch {
      /* observability only */
    }
    onSuccess();
    return response;
  }
  const reader = response.body.getReader();
  const tailDecoder = new TextDecoder();
  const encoder = rewriteModel !== undefined ? new TextEncoder() : null;
  let lineBuffer = '';
  let diagnosticTail = '';
  let hasSeenErrorEvent = false;
  let hasSeenTerminalFailure = false;
  let completionSeen = !completionMarker;
  let completionAt: number | null = null;
  let closeSeen = !(closeMarker ?? completionMarker);
  let nextSequenceNumber = 0;
  let isFinished = false;
  const usageScan = typeof onUsage === 'function' || typeof onAttemptUsage === 'function';
  let usageLines = '';
  let usageCandidate: unknown = null;
  let isUsageReported = false;
  let isAttemptUsageReported = false;
  const startMs = Date.now();
  let chunkCount = 0;
  let receivedBytes = 0;
  let failureReason: string | null = null;

  const emitInterruption = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (hasSeenErrorEvent || typeof interruptionChunk !== 'function') return;
    try {
      const chunk = interruptionChunk(failureReason, { nextSequenceNumber });
      if (chunk instanceof Uint8Array && chunk.byteLength > 0) controller.enqueue(chunk);
    } catch {
      /* diagnostics must never break stream shutdown */
    }
  };

  const scanUsageLine = (text: string) => {
    // Most chunks carry no usage report: when nothing is pending and this one does
    // not mention it, only the unfinished last line has to be remembered.
    if (usageLines === '' && !text.includes('"usage"')) {
      usageLines = text.slice(text.lastIndexOf('\n') + 1);
      if (usageLines.length > 64 * 1024) usageLines = '';
      return;
    }
    usageLines += text;
    if (usageLines.length > 64 * 1024) usageLines = '';
    const lines = usageLines.split('\n');
    usageLines = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const usageAt = line.indexOf('"usage"');
      if (usageAt < 0) continue;
      // Chat chunks that carry only `"usage":null` report nothing; skip the parse.
      if (line.startsWith('"usage":null', usageAt) && line.indexOf('"usage"', usageAt + 7) < 0) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const json = JSON.parse(raw);
        const reported =
          json?.response?.usage !== undefined ? json.response.usage : json?.message?.usage !== undefined ? json.message.usage : json?.usage;
        if (reported !== undefined) {
          const merged = mergeReportedUsage(usageCandidate, reported);
          if (normalizeTokenUsage(merged)) usageCandidate = merged;
        }
      } catch {
        /* passive scan */
      }
    }
  };

  const finalize = (result: 'success' | 'failure' | 'neutral') => {
    if (isFinished) return;
    isFinished = true;

    // A transport-level clean EOF without the protocol completion marker is
    // still a failed upstream attempt. Resolve that semantic outcome BEFORE
    // firing physical-attempt accounting, otherwise truncated streams would be
    // incorrectly labelled success and skipped by the undelivered writer.
    const failed = result === 'failure' || (result === 'success' && !completionSeen);
    const attemptOutcome: 'success' | 'failure' | 'neutral' = result === 'neutral' ? 'neutral' : failed ? 'failure' : 'success';

    if (!isAttemptUsageReported) {
      isAttemptUsageReported = true;
      try {
        onAttemptUsage?.(usageCandidate, attemptOutcome);
      } catch {
        /* fail-open */
      }
    }

    // Existing delivered-response semantics remain success-only.
    if (usageScan && !isUsageReported && attemptOutcome === 'success' && typeof onUsage === 'function') {
      isUsageReported = true;
      try {
        onUsage(usageCandidate);
      } catch {
        /* observability must never break relay */
      }
    }

    if (result === 'success') {
      if (!completionSeen) onFailure();
      else onSuccess();
    } else if (result === 'failure') onFailure();
    else onNeutral();
    onStreamEnd?.(attemptOutcome === 'neutral' ? 'neutral' : failed ? 'interrupted' : 'completed', {
      reason: failed ? failureReason : null,
      durationMs: Date.now() - startMs,
      chunkCount,
      receivedBytes,
      completionMarkerSeen: completionSeen,
    });
  };

  const modelPointer = rewriteModelAt || 'model';
  const modelPointerParts = modelPointer.split('.');
  // A chat stream repeats the same `"model":"<upstream name>"` in every chunk.
  // Once the first one has been rewritten through a full parse, later chunks that
  // carry the exact same token (once) are rewritten by string replacement, which
  // keeps the rest of the line byte for byte and skips parse + stringify.
  const rewriteLiteral = rewriteModel !== undefined ? `"model":${JSON.stringify(rewriteModel)}` : '';
  let learnedModelToken: string | null = null;
  const processLine = (line: string): string => {
    if (!line.startsWith('data:') || !line.includes('"model"')) return line;
    if (learnedModelToken !== null) {
      const at = line.indexOf(learnedModelToken);
      if (at >= 0 && line.indexOf(learnedModelToken, at + learnedModelToken.length) < 0) {
        return line.slice(0, at) + rewriteLiteral + line.slice(at + learnedModelToken.length);
      }
    }
    const raw = line.slice(5).trimStart();
    if (!raw || raw === '[DONE]') return line;
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === 'object') {
        let holder = json;
        for (let i = 0; i < modelPointerParts.length - 1; i++) {
          const part = modelPointerParts[i];
          if (!part) return line;
          holder = holder?.[part];
          if (!holder || typeof holder !== 'object') return line;
        }
        const leaf = modelPointerParts[modelPointerParts.length - 1];
        if (!leaf || holder[leaf] === undefined) return line;
        if (modelPointer === 'model' && typeof holder[leaf] === 'string') learnedModelToken = `"model":${JSON.stringify(holder[leaf])}`;
        holder[leaf] = rewriteModel;
        return `data: ${JSON.stringify(json)}`;
      }
    } catch {
      /* malformed lines pass through untouched */
    }
    return line;
  };

  const forwardBytes = (value: Uint8Array, text: string): Uint8Array => {
    if (!encoder) return value;
    lineBuffer += text;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';
    if (lineBuffer.length > TRACK_MAX_LINE_BUFFER || lines.some((line) => line.length > TRACK_MAX_LINE_BUFFER)) {
      throw new Error('tracked SSE line exceeded the hard limit');
    }
    let out = '';
    for (const line of lines) out += `${processLine(line)}\n`;
    return encoder.encode(out);
  };

  const body = new ReadableStream({
    async pull(controller) {
      if (isFinished) {
        controller.close();
        return;
      }
      let result: Awaited<ReturnType<typeof raceWithIdle>>;
      const graceRemainingMs = completionAt !== null && !closeSeen && completionGraceMs > 0 ? completionAt + completionGraceMs - Date.now() : null;
      if (graceRemainingMs !== null && graceRemainingMs <= 0) {
        reader.cancel().catch(() => {});
        if (encoder && lineBuffer) {
          controller.enqueue(encoder.encode(lineBuffer));
          lineBuffer = '';
        }
        finalize('success');
        controller.close();
        return;
      }
      const effectiveIdleTimeoutMs =
        graceRemainingMs === null ? idleTimeoutMs : Math.min(idleTimeoutMs > 0 ? idleTimeoutMs : graceRemainingMs, graceRemainingMs);
      try {
        result = await raceWithIdle(reader.read(), effectiveIdleTimeoutMs);
      } catch {
        failureReason = 'reader_error';
        emitInterruption(controller);
        finalize('failure');
        try {
          controller.close();
        } catch {
          /* closed */
        }
        return;
      }
      if (result.timeout) {
        reader.cancel().catch(() => {});
        if (graceRemainingMs !== null) {
          if (encoder && lineBuffer) {
            controller.enqueue(encoder.encode(lineBuffer));
            lineBuffer = '';
          }
          finalize('success');
          controller.close();
          return;
        }
        failureReason = 'idle_timeout';
        emitInterruption(controller);
        finalize('failure');
        controller.close();
        return;
      }
      const { done, value } = result.value;
      if (done) {
        let hiddenReason: string | null = null;
        try {
          hiddenReason = upstreamFailureReason?.() || null;
        } catch {
          /* diagnostic only */
        }
        failureReason = hiddenReason || 'missing_completion_marker';
        if (encoder && lineBuffer) {
          controller.enqueue(encoder.encode(lineBuffer));
          lineBuffer = '';
        }
        if (!completionSeen && !hasSeenTerminalFailure) emitInterruption(controller);
        finalize(hasSeenErrorEvent || hasSeenTerminalFailure ? 'failure' : 'success');
        controller.close();
        return;
      }
      chunkCount++;
      receivedBytes += value.byteLength;
      // Decoded once per chunk and shared by the scans and the model rewrite. The
      // rewrite needs every chunk decoded, so the decoder never skips one.
      let decoded = '';
      if (encoder || !hasSeenErrorEvent || !completionSeen) decoded = tailDecoder.decode(value, { stream: true });
      if (!hasSeenErrorEvent || !completionSeen) {
        if (usageScan && !closeSeen) scanUsageLine(decoded);
        const scanWindow = diagnosticTail + decoded;
        if (interruptionChunk) {
          const sequencePattern = /"sequence_number"\s*:\s*(\d+)/g;
          let match = sequencePattern.exec(scanWindow);
          while (match) {
            nextSequenceNumber = Math.max(nextSequenceNumber, Number(match[1]) + 1);
            match = sequencePattern.exec(scanWindow);
          }
        }
        if (!hasSeenErrorEvent) {
          hasSeenErrorEvent = /(?:^|\r?\n)event:\s*error\s*(?:\r?\n|$)/.test(scanWindow);
        }
        if (!hasSeenTerminalFailure && failureMarker?.test(scanWindow)) hasSeenTerminalFailure = true;
        if (!completionSeen && completionMarker?.test(scanWindow)) {
          completionSeen = true;
          completionAt = Date.now();
        }
        if (!closeSeen && (closeMarker ?? completionMarker)?.test(scanWindow)) closeSeen = true;
        diagnosticTail = scanWindow.slice(-256);
      }
      let forwarded: Uint8Array;
      try {
        forwarded = forwardBytes(value, decoded);
      } catch {
        reader.cancel().catch(() => {});
        failureReason = 'reader_error';
        emitInterruption(controller);
        finalize('failure');
        try {
          controller.close();
        } catch {
          /* closed */
        }
        return;
      }
      controller.enqueue(forwarded);
      if ((closeMarker ?? completionMarker) && closeSeen) {
        reader.cancel().catch(() => {});
        try {
          if (encoder && lineBuffer) {
            controller.enqueue(encoder.encode(lineBuffer));
            lineBuffer = '';
          }
        } catch {
          /* already closed */
        }
        finalize('success');
        controller.close();
        return;
      }
    },
    cancel() {
      finalize('neutral');
      reader.cancel().catch(() => {});
    },
  });

  onStreamStart?.();

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function raceWithIdle(
  readPromise: Promise<ReadableStreamReadResult<Uint8Array>>,
  idleTimeoutMs: number,
): Promise<{ timeout: false; value: ReadableStreamReadResult<Uint8Array> } | { timeout: true }> {
  if (!idleTimeoutMs || idleTimeoutMs <= 0) return { timeout: false, value: await readPromise };
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
    timerId = setTimeout(() => resolve({ timeout: true }), idleTimeoutMs);
  });
  try {
    return await Promise.race([readPromise.then((value) => ({ timeout: false as const, value })), timeoutPromise]);
  } finally {
    clearTimeout(timerId);
  }
}

export type RelayOptions = {
  idleTimeoutMs: number;
  onSuccess: () => void;
  onFailure: () => void;
  onNeutral: () => void;
  onStreamStart?: () => void;
  onStreamEnd?: (outcome: string, info: TrackStreamEndInfo) => void;
  onAttemptUsage?: (usage: unknown, outcome: 'success' | 'failure' | 'neutral') => void;
  /** Delivered-response usage callback, mirroring TrackOptions.onUsage
   *  semantics: fires once on a cleanly completed stream, before onSuccess. */
  onUsage?: () => void;
};

/**
 * Pass-through stream relay (AIG_STREAM_PASSTHROUGH): move every byte from the
 * upstream to the client without decoding, scanning, rewriting or usage
 * observation. Each chunk is forwarded as received, so per-chunk cost is one
 * read + one enqueue instead of a decode plus several regex scans.
 *
 * Accepted trade-offs (documented in changelog.d/stream-passthrough.md):
 *   - no completion-marker knowledge: a truncated stream that ends with a
 *     clean transport EOF is accounted as delivered output;
 *   - no model rewrite: the client sees the upstream's model spelling;
 *   - no usage sampling: delivered/attempts token rows carry no usage;
 *   - no synthetic interruption events: a lost stall ends like a normal close.
 * Kept for reliability: the idle timeout (a stalled upstream is cut and the
 * attempt is recorded as failed) and cancel() propagation (a disconnecting
 * client cancels the upstream body). Semantics of onSuccess/onFailure/
 * onNeutral/onStreamStart/onStreamEnd/onAttemptUsage match
 * makeNodeStreamTrack's callbacks exactly, so callers can reuse them.
 */
export function relayStreamResponse(
  response: Response,
  { idleTimeoutMs, onSuccess, onFailure, onNeutral, onStreamStart, onStreamEnd, onAttemptUsage, onUsage }: RelayOptions,
): Response {
  if (!response.body) {
    try {
      onAttemptUsage?.(null, 'success');
    } catch {
      /* observability only */
    }
    try {
      onUsage?.();
    } catch {
      /* observability only */
    }
    onSuccess();
    return response;
  }
  const reader = response.body.getReader();
  const startMs = Date.now();
  let chunkCount = 0;
  let receivedBytes = 0;
  let isFinished = false;

  const finalize = (result: 'success' | 'failure' | 'neutral'): void => {
    if (isFinished) return;
    isFinished = true;
    const attemptOutcome: 'success' | 'failure' | 'neutral' = result === 'neutral' ? 'neutral' : 'success';
    try {
      onAttemptUsage?.(null, attemptOutcome);
    } catch {
      /* fail-open */
    }
    if (result === 'success') onSuccess();
    else if (result === 'failure') onFailure();
    else onNeutral();
    // Success-only delivered usage, mirroring TrackOptions.onUsage semantics.
    if (result === 'success') {
      try {
        onUsage?.();
      } catch {
        /* observability must never break relay */
      }
    }
    onStreamEnd?.(attemptOutcome === 'neutral' ? 'neutral' : 'completed', {
      reason: null,
      durationMs: Date.now() - startMs,
      chunkCount,
      receivedBytes,
      completionMarkerSeen: false,
    });
  };

  const body = new ReadableStream({
    async pull(controller) {
      if (isFinished) {
        controller.close();
        return;
      }
      let result: Awaited<ReturnType<typeof raceWithIdle>>;
      try {
        result = await raceWithIdle(reader.read(), idleTimeoutMs);
      } catch {
        finalize('failure');
        try {
          controller.close();
        } catch {
          /* closed */
        }
        return;
      }
      if (result.timeout) {
        reader.cancel().catch(() => {});
        finalize('failure');
        controller.close();
        return;
      }
      const { done, value } = result.value;
      if (done) {
        finalize('success');
        controller.close();
        return;
      }
      chunkCount++;
      receivedBytes += value.byteLength;
      controller.enqueue(value);
    },
    cancel() {
      finalize('neutral');
      reader.cancel().catch(() => {});
    },
  });

  onStreamStart?.();

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
