import { createSseScanner } from './sse.ts';

export function convertSseStream(
  body: ReadableStream<Uint8Array> | null | undefined,
  onData: (data: string, controller: ReadableStreamDefaultController<Uint8Array>) => void,
  isTerminal: () => boolean,
  onEnd?: (controller: ReadableStreamDefaultController<Uint8Array>) => boolean,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let scanner: ReturnType<typeof createSseScanner> | undefined;
  let cancelled = false;
  let isFinished = false;
  let cleanup: Promise<void> | undefined;
  const decoder = new TextDecoder();

  const stopUpstream = (reason?: unknown): Promise<void> => {
    if (!reader) return Promise.resolve();
    if (!cleanup) {
      const upstream = reader;
      cleanup = (async () => {
        try {
          await upstream.cancel(reason);
        } catch {
        } finally {
          upstream.releaseLock();
        }
      })();
    }
    return cleanup;
  };

  return new ReadableStream({
    start(controller) {
      if (!body) {
        isFinished = true;
        controller.error(new Error('Upstream stream body is not readable'));
        return;
      }
      reader = body.getReader();
      scanner = createSseScanner((data) => {
        if (!cancelled && !isTerminal() && data) onData(data, controller);
      });
    },
    async pull(controller) {
      if (cancelled || isFinished || !reader || !scanner) return;
      try {
        let hasReachedEnd = false;
        while (!cancelled && !isTerminal() && (controller.desiredSize ?? 0) > 0) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) {
            scanner.push(decoder.decode());
            scanner.flush();
            if (!isTerminal() && !onEnd?.(controller)) throw new Error('Upstream stream interrupted before terminal event');
            hasReachedEnd = true;
            break;
          }
          scanner.push(decoder.decode(value, { stream: true }));
        }
        if (!cancelled && (isTerminal() || hasReachedEnd)) {
          isFinished = true;
          controller.close();
          await stopUpstream();
        }
      } catch (error) {
        if (!cancelled) {
          isFinished = true;
          controller.error(error);
        }
        await stopUpstream();
      }
    },
    cancel(reason) {
      cancelled = true;
      return stopUpstream(reason);
    },
  });
}
