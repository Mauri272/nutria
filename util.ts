/** Utilidades puras: fechas locales (YYYY-MM-DD), formato y escape HTML. */

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Fecha LOCAL del dispositivo como YYYY-MM-DD (no UTC: así "hoy" coincide con el reloj del usuario). */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0); // mediodía: inmune a saltos de horario de verano
}

export function addDays(s: string, n: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return localDate(d);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}

/** Lunes de la semana de la fecha dada. */
export function weekStart(s: string): string {
  const dow = (parseDate(s).getDay() + 6) % 7; // lunes = 0
  return addDays(s, -dow);
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

export function shortDate(s: string): string {
  const d = parseDate(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function longDate(s: string): string {
  const d = parseDate(s);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function fmt(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('es-CL', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Número desde un campo de texto ("72,5" o "72.5"); null si vacío o inválido. */
export function parseNum(s: string | null | undefined): number | null {
  if (s === null || s === undefined || s.trim() === '') return null;
  const n = Number(s.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
