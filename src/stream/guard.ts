const guardedStreamState = new WeakMap<object, { failureReason: string | null }>();

import { createSseScanner, GUARD_ERROR, type GuardErrorCode, guardError, type SseEventHandler } from '../../packages/transport/sse.ts';

export type { GuardErrorCode, SseEventHandler, SseEventState } from '../../packages/transport/sse.ts';
export { createSseScanner, FIRST_EVENT_MAX_SSE_LINE, GUARD_ERROR, readWithDeadline } from '../../packages/transport/sse.ts';

export const FIRST_EVENT_MAX_PRE_BYTES = 2 * 1024 * 1024;

export const FIRST_EVENT_MAX_PRE_BYTES_PASSTHROUGH = 64 * 1024;

export function guardedStreamFailureReason(response: Response): string | null {
  return guardedStreamState.get(response)?.failureReason || null;
}

export async function ensureFirstSseEvent(
  upstreamResponse: Response,
  timeoutMs: number,
  clientSignal: AbortSignal | null | undefined,
  isRealOutput: ((json: unknown) => boolean) | undefined,
  onParsedEvent?: (json: unknown) => void,
  options: { maxPreBytes?: number } = {},
): Promise<Response> {
  if (!upstreamResponse.body) throw guardError(GUARD_ERROR.EMPTY);
  const maxPreBytes = typeof options.maxPreBytes === 'number' && options.maxPreBytes > 0 ? options.maxPreBytes : FIRST_EVENT_MAX_PRE_BYTES;
  const reader = upstreamResponse.body.getReader();
  const consumed: Uint8Array[] = [];
  let isSettled = false;

  return await new Promise((resolve, reject) => {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finishErr(GUARD_ERROR.ABORTED);

    const finishOk = () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timerId);
      clientSignal?.removeEventListener('abort', abort);
      const state: { failureReason: string | null } = { failureReason: null };
      const replayChunks = consumed.reverse();
      const stream = new ReadableStream(
        {
          pull(controller) {
            const buffered = replayChunks.pop();
            if (buffered) {
              controller.enqueue(buffered);
              return;
            }
            return pull(reader, controller, state);
          },
          cancel() {
            reader.cancel().catch(() => {});
          },
        },
        { highWaterMark: 0 },
      );
      const replay = new Response(stream, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: upstreamResponse.headers,
      });
      guardedStreamState.set(replay, state);
      resolve(replay);
    };

    const finishErr = (code: GuardErrorCode) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timerId);
      clientSignal?.removeEventListener('abort', abort);
      reader.cancel().catch(() => {});
      reject(guardError(code));
    };

    const check = (data: string) => {
      if (data === '[DONE]') {
        finishErr(GUARD_ERROR.DONE_ONLY);
        return;
      }
      // biome-ignore lint/suspicious/noImplicitAnyLet: upstream SSE events are dynamic untrusted JSON at this protocol boundary; tsc treats the evolving `let json` as any
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        finishErr(GUARD_ERROR.MALFORMED);
        return;
      }
      try {
        onParsedEvent?.(json);
      } catch {}
      if (json && typeof json === 'object' && !Array.isArray(json) && json.error) {
        finishErr(GUARD_ERROR.ERROR_ENVELOPE);
        return;
      }
      if (isRealOutput && !isRealOutput(json)) return;
      finishOk();
    };

    if (clientSignal?.aborted) {
      finishErr(GUARD_ERROR.ABORTED);
      return;
    }
    clientSignal?.addEventListener('abort', abort, { once: true });
    timerId = setTimeout(() => finishErr(GUARD_ERROR.TIMEOUT), timeoutMs);

    void consumeSseEventsWithReader(reader, check, consumed, () => isSettled, maxPreBytes)
      .then(() => {
        if (!isSettled) finishErr(GUARD_ERROR.EMPTY);
      })
      .catch((error) => {
        if (!isSettled) finishErr(error?.code || GUARD_ERROR.EMPTY);
      });
  });
}

async function consumeSseEventsWithReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onData: SseEventHandler,
  consumed: Uint8Array[],
  isSettled: () => boolean,
  maxPreBytes: number,
): Promise<void> {
  const decoder = new TextDecoder();
  const scanner = createSseScanner(onData);
  let preBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || isSettled()) break;
    if (consumed) consumed.push(value);
    preBytes += value.byteLength;
    if (preBytes > maxPreBytes) {
      reader.cancel().catch(() => {});
      throw guardError(GUARD_ERROR.PRE_EVENT_BYTES_EXCEEDED);
    }
    scanner.push(decoder.decode(value, { stream: true }));
    if (isSettled()) break;
  }
  if (!isSettled()) scanner.flush();
}

async function pull(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: { failureReason: string | null },
): Promise<void> {
  try {
    const { done, value } = await reader.read();
    if (done) controller.close();
    else controller.enqueue(value);
  } catch {
    state.failureReason = 'reader_error';
    try {
      controller.close();
    } catch {}
  }
}
