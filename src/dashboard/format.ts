export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 10000) return String(Math.trunc(n));
  if (n < 1e8) {
    const v = n / 1e4;
    const s = v >= 100 ? Math.round(v) : Number.isInteger(v) ? v : v.toFixed(1);
    return `${s}万`;
  }
  const v = n / 1e8;
  const s = v >= 100 ? Math.round(v) : Number.isInteger(v) ? v : v.toFixed(2);
  return `${s}亿`;
}

export function fmtInt(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function fmtTtft(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (Number.isInteger(sec)) return `${sec}s`;
  return `${sec.toFixed(1)}s`;
}

export function fmtTooltipDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

export function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return String(s).replace(/[&<>"']/g, (c) => map[c] ?? c);
}
