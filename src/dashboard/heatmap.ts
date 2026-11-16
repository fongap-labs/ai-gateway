export type HeatmapMode = 'rolling-52-weeks' | 'calendar-year';

export type HeatmapDay = {
  date: string;
  value: number | null;
  weekIndex: number;
  weekdayIndex: number;
  inRange: boolean;
  isFuture: boolean;
};

export type MonthLabel = {
  year: number;
  month: number;
  weekIndex: number;
};

export type HeatmapResult = {
  weeks: HeatmapDay[][];
  monthLabels: MonthLabel[];
  rangeStart: string;
  rangeEnd: string;
  mode: HeatmapMode;
};

export type HeatmapDataEntry = { total: number; requests: number };

const DAY_MS = 86_400_000;

function utc8DayStartUtcMs(nowMs: number): number {
  const MS_8H = 8 * 60 * 60 * 1000;
  return Math.floor((nowMs + MS_8H) / DAY_MS) * DAY_MS - MS_8H;
}

function isoDayUtc8(dayStartUtc8: number): string {
  return new Date(dayStartUtc8 + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function weekdayIndexOf(iso: string): number {
  return (new Date(iso).getUTCDay() + 6) % 7;
}

function isoUtc(dayMs: number): string {
  return new Date(dayMs).toISOString().slice(0, 10);
}

function buildEmptyGrid(
  mode: HeatmapMode,
  todayIso: string,
  year: number | null | undefined,
): { weeks: HeatmapDay[][]; rangeStart: string; rangeEnd: string } {
  if (mode === 'rolling-52-weeks') {
    const todayMs = new Date(`${todayIso}T00:00:00Z`).getTime();
    const dow = (new Date(todayIso).getUTCDay() + 6) % 7;
    const currentWeekStart = todayMs - dow * DAY_MS;
    const firstWeekStart = currentWeekStart - 51 * 7 * DAY_MS;
    const rangeStartIso = isoUtc(firstWeekStart);
    const weeks: HeatmapDay[][] = [];
    for (let w = 0; w < 52; w += 1) {
      const week: HeatmapDay[] = [];
      const weekStartMs = firstWeekStart + w * 7 * DAY_MS;
      for (let d = 0; d < 7; d += 1) {
        const dayMs = weekStartMs + d * DAY_MS;
        const iso = new Date(dayMs).toISOString().slice(0, 10);
        const future = iso > todayIso;
        week.push({
          date: iso,
          value: null,
          weekIndex: w,
          weekdayIndex: d,
          inRange: iso >= rangeStartIso,
          isFuture: future,
        });
      }
      weeks.push(week);
    }
    return { weeks, rangeStart: isoUtc(firstWeekStart), rangeEnd: isoUtc(currentWeekStart + 6 * DAY_MS) };
  }

  if (mode === 'calendar-year') {
    const knownYear = typeof year === 'number' && Number.isInteger(year) ? year : new Date(`${todayIso}T00:00:00Z`).getUTCFullYear();
    const rangeStart = `${knownYear}-01-01`;
    const rangeEnd = `${knownYear}-12-31`;
    const startDow = weekdayIndexOf(rangeStart);
    const startMs = new Date(`${rangeStart}T00:00:00Z`).getTime() - startDow * DAY_MS;
    const endDow = weekdayIndexOf(rangeEnd);
    const endMs = new Date(`${rangeEnd}T00:00:00Z`).getTime() + (6 - endDow) * DAY_MS;
    const weeks: HeatmapDay[][] = [];
    let w = 0;
    for (let dayMs = startMs; dayMs <= endMs; dayMs += DAY_MS * 7) {
      const week: HeatmapDay[] = [];
      for (let d = 0; d < 7; d += 1) {
        const cellMs = dayMs + d * DAY_MS;
        const iso = new Date(cellMs).toISOString().slice(0, 10);
        const inRange = iso >= rangeStart && iso <= rangeEnd;
        const future = inRange && iso > todayIso;
        week.push({
          date: iso,
          value: null,
          weekIndex: w,
          weekdayIndex: d,
          inRange,
          isFuture: future,
        });
      }
      weeks.push(week);
      w += 1;
    }
    return { weeks, rangeStart, rangeEnd };
  }

  throw new Error(`buildCalendarHeatmap: unknown mode "${mode}"`);
}

export function buildCalendarHeatmap(opts: {
  mode: HeatmapMode;
  today: number | Date;
  year?: number;
  weekStartsOn?: 'monday';
  data?: Map<string, HeatmapDataEntry> | null;
  valueKey?: 'total' | 'requests';
}): HeatmapResult {
  const { mode, year, data = null, valueKey = 'total' } = opts || {};
  if (!mode) throw new Error('buildCalendarHeatmap: mode is required');
  const todayMs = opts.today instanceof Date ? opts.today.getTime() : Number(opts.today);
  if (!Number.isFinite(todayMs)) throw new Error('buildCalendarHeatmap: today must be a Date or a UTC ms number');
  const todayStartUtc8 = utc8DayStartUtcMs(todayMs);
  const todayIso = isoDayUtc8(todayStartUtc8);

  const grid = buildEmptyGrid(mode, todayIso, year);
  const weeks = grid.weeks;

  for (const week of weeks) {
    for (const cell of week) {
      if (!cell.inRange || cell.isFuture) continue;
      const v = data?.get(cell.date);
      cell.value = v && Number.isFinite(v[valueKey]) ? v[valueKey] : 0;
    }
  }

  const monthLabels = computeMonthLabels(weeks, mode, year, todayIso);

  return {
    weeks,
    monthLabels,
    rangeStart: grid.rangeStart,
    rangeEnd: grid.rangeEnd,
    mode,
  };
}

function computeMonthLabels(weeks: HeatmapDay[][], mode: HeatmapMode, year: number | null | undefined, todayIso: string): MonthLabel[] {
  const labels: MonthLabel[] = [];
  if (mode === 'calendar-year') {
    const y = year ?? Number(todayIso.slice(0, 4));
    for (let m = 0; m < 12; m += 1) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const wIdx = weekIndexOf(weeks, iso);
      if (wIdx === -1) continue;
      labels.push({ year: y, month: m, weekIndex: wIdx });
    }
    return labels;
  }

  if (!weeks.length) return labels;
  const firstIso = weeks[0]?.[0]?.date;
  const lastIso = weeks[weeks.length - 1]?.[6]?.date;
  if (!firstIso || !lastIso) return labels;
  let cursor = `${firstIso.slice(0, 7)}-01`;
  while (cursor <= lastIso) {
    const wIdx = weekIndexOf(weeks, cursor);
    if (wIdx !== -1) {
      const y = Number(cursor.slice(0, 4));
      const m = Number(cursor.slice(5, 7)) - 1;
      if (!labels.some((l) => l.year === y && l.month === m && l.weekIndex === wIdx)) {
        labels.push({ year: y, month: m, weekIndex: wIdx });
      }
    }
    const next = nextMonthIso(cursor);
    cursor = next;
  }
  return labels;
}

function weekIndexOf(weeks: HeatmapDay[][], iso: string): number {
  for (let w = 0; w < weeks.length; w += 1) {
    for (let d = 0; d < 7; d += 1) {
      if (weeks[w]?.[d]?.date === iso) return w;
    }
  }
  return -1;
}

function nextMonthIso(ym1: string): string {
  const y = Number(ym1.slice(0, 4));
  const m = Number(ym1.slice(5, 7));
  if (m === 12) return `${y + 1}-01-01`;
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
