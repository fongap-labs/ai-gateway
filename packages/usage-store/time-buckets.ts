const DAY_MS = 86_400_000;

export function getUtcHourBucket(date: number | Date = Date.now()): string {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:00:00Z`;
}

export function getUtcDayBucket(date: number | Date = Date.now()): string {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getUtcWeekBucket(date: number | Date = Date.now()): string {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getUTCDay() || 7;
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + (4 - day));
  const weekYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(weekYear, 0, 1));
  const diffDays = Math.round((thursday.getTime() - jan1.getTime()) / DAY_MS);
  const week = Math.floor((diffDays + 1 - jan1.getUTCDay() + 7) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

export function getUtcWeekStartUtcMs(date: number | Date = Date.now()): number {
  const t = typeof date === 'number' ? date : date.getTime();
  const d = new Date(t);
  const dow = (d.getUTCDay() + 6) % 7;
  const dayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return dayMs - dow * DAY_MS;
}
