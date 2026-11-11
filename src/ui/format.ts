// Number / time / colour formatting helpers (Italian style: 12,3k · 1,2M).

function trimDec(s: string): string {
  return s.replace(/\.0+$/, '').replace('.', ',');
}

/** 950 · 1,2k · 12,3k · 123k · 1,2M */
export function fmt(n: number): string {
  if (!isFinite(n)) return '—';
  const neg = n < 0;
  const a = Math.abs(n);
  let s: string;
  if (a < 1000) s = String(Math.floor(a));
  else if (a < 100_000) s = trimDec((a / 1000).toFixed(1)) + 'k';
  else if (a < 1_000_000) s = Math.floor(a / 1000) + 'k';
  else if (a < 100_000_000) s = trimDec((a / 1_000_000).toFixed(1)) + 'M';
  else s = Math.floor(a / 1_000_000) + 'M';
  return neg ? '−' + s : s;
}

/** Signed rate: +12,3 · +1,2k */
export function fmtRate(n: number): string {
  if (!isFinite(n)) return '—';
  const a = Math.abs(n);
  const s = a < 100 ? trimDec(a.toFixed(1)) : fmt(a);
  return (n < 0 ? '−' : '+') + s;
}

/** 0..1 → "12,3%" */
export function pct(x: number, digits?: number): string {
  if (!isFinite(x)) return '—';
  if (digits === undefined) digits = x > 0 && x < 0.01 ? 2 : 1;
  return trimDec((x * 100).toFixed(digits)) + '%';
}

/** Full integer with thin thousands separators: 12.345 */
export function fmtInt(n: number): string {
  return Math.floor(n).toLocaleString('it-IT');
}

/** Ticks (10/s) → "mm:ss" or "h:mm:ss". */
export function clock(ticks: number): string {
  const s = Math.floor(ticks / 10);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (v: number) => String(v).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

export function hexColor(c: number): string {
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
}

export function parseHex(s: string): number {
  return parseInt(s.replace('#', ''), 16) & 0xffffff;
}

export const KIND_LABEL: Record<string, string> = { human: 'Giocatore', nation: 'Nazione', tribe: 'Tribù' };
