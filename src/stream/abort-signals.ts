export type CombinedAbortSignal = { signal: AbortSignal; dispose: () => void };

export function combineAbortSignals(clientSignal: AbortSignal, hedgeSignal: AbortSignal | undefined): CombinedAbortSignal {
  if (!hedgeSignal) return { signal: clientSignal, dispose: () => {} };
  const signals = [clientSignal, hedgeSignal];
  const signalAny = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof signalAny === 'function') return { signal: signalAny(signals), dispose: () => {} };

  const controller = new AbortController();
  const listeners = signals.map((signal) => {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return { signal, abort };
  });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, abort } of listeners) signal.removeEventListener('abort', abort);
    },
  };
}
