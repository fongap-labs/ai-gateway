let activeHandlers = 0;
let peakHandlers = 0;
let startedTotal = 0;
let completedTotal = 0;

export function trackIsolateRequest(): () => void {
  activeHandlers++;
  startedTotal++;
  peakHandlers = Math.max(peakHandlers, activeHandlers);
  let isReleased = false;
  return () => {
    if (isReleased) return;
    isReleased = true;
    activeHandlers = Math.max(0, activeHandlers - 1);
    completedTotal++;
  };
}

export function snapshotIsolateRequestActivity(): {
  active: number;
  peak: number;
  started: number;
  completed: number;
} {
  return { active: activeHandlers, peak: peakHandlers, started: startedTotal, completed: completedTotal };
}

export function __resetIsolateConcurrencyForTests(): void {
  activeHandlers = 0;
  peakHandlers = 0;
  startedTotal = 0;
  completedTotal = 0;
}
