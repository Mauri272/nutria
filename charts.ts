/** Gráficos SVG sin dependencias. Los colores vienen de clases CSS (tokens claro/oscuro). Tooltips: atributo data-tip. */
import type { WeightPoint } from './model';
import { daysBetween, esc, fmt, shortDate } from './util';

export function ring(value: number, target: number, size = 168): string {
  const r = (size - 18) / 2;
  const c = 2 * Math.PI * r;
  const frac = target > 0 ? Math.min(1, value / target) : 0;
  const over = target > 0 && value > target;
  const cx = size / 2;
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${fmt(value)} de ${fmt(target)} kcal">
    <circle class="ring-track" cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke-width="14"/>
    <circle class="ring-fill${over ? ' over' : ''}" cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke-width="14" stroke-linecap="round"
      stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cx})"/>
  </svg>`;
}

function niceStep(range: number, ticks: number): number {
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function yTicks(min: number, max: number): number[] {
  const step = niceStep(max - min || 1, 4);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

const W = 340;
const H = 190;
const PAD = { l: 38, r: 12, t: 12, b: 24 };

/** Peso diario (puntos) + EMA de 7 días (línea de 2 px, punto final con anillo). */
export function weightChart(points: readonly WeightPoint[]): string {
  if (points.length === 0) return '';
  const vals = points.flatMap((p) => [p.w, p.ema]);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const padv = Math.max(0.4, (hi - lo) * 0.15);
  lo -= padv;
  hi += padv;
  const first = points[0] as WeightPoint;
  const last = points[points.length - 1] as WeightPoint;
  const span = Math.max(1, daysBetween(first.date, last.date));
  const x = (d: string) => PAD.l + ((W - PAD.l - PAD.r) * daysBetween(first.date, d)) / span;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo));
  const ticks = yTicks(lo, hi);
  const grid = ticks
    .map((t) => `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="axis" x="${PAD.l - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${fmt(t, ticks.some((v) => v % 1 !== 0) ? 1 : 0)}</text>`)
    .join('');
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.ema).toFixed(1)}`).join(' ');
  const dots = points
    .map((p) => `<circle class="raw" cx="${x(p.date).toFixed(1)}" cy="${y(p.w).toFixed(1)}" r="2.5"/>`)
    .join('');
  const hits = points
    .map((p) => `<circle class="hit" cx="${x(p.date).toFixed(1)}" cy="${y(p.ema).toFixed(1)}" r="11" data-tip="${esc(`${shortDate(p.date)} · peso ${fmt(p.w, 1)} kg · tendencia ${fmt(p.ema, 1)} kg`)}"/>`)
    .join('');
  const end = `<circle class="end-ring" cx="${x(last.date).toFixed(1)}" cy="${y(last.ema).toFixed(1)}" r="6.5"/><circle class="end" cx="${x(last.date).toFixed(1)}" cy="${y(last.ema).toFixed(1)}" r="4.5"/>`;
  const xl = `<text class="axis" x="${PAD.l}" y="${H - 6}">${shortDate(first.date)}</text>${span > 0 && points.length > 1 ? `<text class="axis" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${shortDate(last.date)}</text>` : ''}`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Peso diario y tendencia de 7 días">${grid}${dots}<path class="ema" d="${line}" fill="none"/>${end}${xl}${hits}</svg>`;
}

export interface Bar {
  label: string;
  value: number | null;
  tip: string;
}

/** Columnas (≤ 24 px, extremo redondeado de 4 px). `signed`: valores ±, color distinto por signo, base en 0. */
export function barChart(bars: readonly Bar[], opts: { cls: string; signed?: boolean; unit: string; refLine?: number | undefined; digits?: number }): string {
  const vals = bars.map((b) => b.value).filter((v): v is number => v !== null);
  if (vals.length === 0) return '<p class="muted small">Sin datos todavía.</p>';
  let lo = opts.signed ? Math.min(0, ...vals) : 0;
  let hi = Math.max(opts.signed ? 0 : 1, ...vals, opts.refLine ?? -Infinity);
  if (opts.signed && lo === hi) hi = lo + 1;
  const pad = (hi - lo) * 0.08;
  hi += pad;
  if (opts.signed && lo < 0) lo -= pad;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo));
  const slot = (W - PAD.l - PAD.r) / bars.length;
  const bw = Math.min(24, slot - 4);
  const ticks = yTicks(lo, hi);
  const grid = ticks
    .map((t) => `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="axis" x="${PAD.l - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${fmt(t, opts.digits ?? 0)}</text>`)
    .join('');
  const base = y(0);
  const body = bars
    .map((b, i) => {
      const cx = PAD.l + slot * i + slot / 2;
      const labelEvery = bars.length > 8 ? 2 : 1;
      const lab = i % labelEvery === 0 ? `<text class="axis" x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>` : '';
      if (b.value === null) return lab;
      const yv = y(b.value);
      const up = b.value >= 0;
      const top = up ? yv : base;
      const h = Math.max(1, Math.abs(yv - base));
      const cls = opts.signed ? (up ? 'gain' : 'loss') : opts.cls;
      const r = Math.min(4, h / 2);
      // Extremo de datos redondeado, base cuadrada: path con esquinas redondeadas solo hacia el valor.
      const x0 = cx - bw / 2;
      const x1 = cx + bw / 2;
      const d = up
        ? `M${x0},${top + h} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x1 - r} Q${x1},${top} ${x1},${top + r} V${top + h} Z`
        : `M${x0},${top} V${top + h - r} Q${x0},${top + h} ${x0 + r},${top + h} H${x1 - r} Q${x1},${top + h} ${x1},${top + h - r} V${top} Z`;
      return `<path class="bar ${cls}" d="${d}"/><rect class="hit" x="${(cx - slot / 2).toFixed(1)}" y="${PAD.t}" width="${slot.toFixed(1)}" height="${H - PAD.t - PAD.b}" data-tip="${esc(b.tip)}"/>${lab}`;
    })
    .join('');
  const ref = opts.refLine !== undefined ? `<line class="refline" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(opts.refLine).toFixed(1)}" y2="${y(opts.refLine).toFixed(1)}"/>` : '';
  const zero = opts.signed ? `<line class="baseline" x1="${PAD.l}" x2="${W - PAD.r}" y1="${base.toFixed(1)}" y2="${base.toFixed(1)}"/>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${grid}${zero}${ref}${body}</svg>`;
}
