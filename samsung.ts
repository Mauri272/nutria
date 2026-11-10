/**
 * Importador del "Descargar datos personales" de Samsung Health (CSV). El formato NO está documentado
 * oficialmente: este lector se basa en los nombres de archivo y columnas conocidos por la comunidad y es
 * tolerante (detecta columnas por nombre). Siempre devuelve un informe de lo que reconoció.
 */
import { pad2 } from './util';

export interface CsvFile {
  name: string;
  text: string;
}
export interface SleepDay {
  min: number;
  stages?: { awake: number; light: number; deep: number; rem: number };
}
export interface SamsungImport {
  steps: Record<string, number>;
  sleep: Record<string, SleepDay>;
  weights: Record<string, { kg: number; bodyFat: number | null }>;
  report: string[];
}

/** CSV con comillas (RFC 4180 básico). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const KNOWN = new Set(['day_time', 'start_time', 'end_time', 'create_time', 'count', 'step_count', 'weight', 'stage', 'sleep_id']);

function normHeader(h: string): string {
  const t = h.trim();
  return t.includes('com.samsung') ? (t.split('.').pop() as string) : t;
}

/** Tabla con encabezado: la 1.ª fila con alguna columna conocida (Samsung antepone una línea de metadatos). */
export function readTable(text: string): { cols: Map<string, number>; rows: string[][] } | null {
  const all = parseCsv(text);
  for (let i = 0; i < Math.min(4, all.length); i++) {
    const hdr = (all[i] as string[]).map(normHeader);
    if (hdr.filter((h) => KNOWN.has(h)).length >= 2) {
      const cols = new Map<string, number>();
      hdr.forEach((h, idx) => {
        if (!cols.has(h)) cols.set(h, idx);
      });
      return { cols, rows: all.slice(i + 1) };
    }
  }
  return null;
}

function offsetMs(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const t = v.trim();
  if (/^-?\d+$/.test(t)) return Number(t);
  const m = /^UTC([+-])(\d{2}):?(\d{2})$/.exec(t);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : null;
}

/** Instante UTC (ms) de un valor de fecha: epoch en ms o "YYYY-MM-DD HH:mm:ss(.SSS)" interpretado como UTC. */
export function toEpoch(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (/^\d{10,}$/.test(t)) return Number(t);
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(t);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)) : null;
}

function ymdUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Fecha local de un instante: con time_offset del archivo; si no, con la zona del dispositivo. */
function localYmd(epoch: number, off: number | null): string {
  if (off !== null) return ymdUtc(epoch + off);
  const d = new Date(epoch);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `day_time` ya representa el día (medianoche local guardada como UTC, o texto): se toma su fecha tal cual. */
function dayOf(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  if (m) return m[1] as string;
  const e = toEpoch(t);
  return e === null ? null : ymdUtc(e);
}

const cell = (r: string[], cols: Map<string, number>, k: string): string | undefined => {
  const i = cols.get(k);
  return i === undefined ? undefined : r[i];
};
const numOf = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const STAGE: Record<string, 'awake' | 'light' | 'deep' | 'rem'> = { '40001': 'awake', '40002': 'light', '40003': 'deep', '40004': 'rem' };

type Kind = 'daily_trend' | 'pedometer' | 'step_count' | 'sleep' | 'sleep_stage' | 'weight';
function kindOf(name: string): Kind | null {
  const n = name.toLowerCase();
  if (n.includes('step_daily_trend')) return 'daily_trend';
  if (n.includes('pedometer_day_summary')) return 'pedometer';
  if (/health\.step_count\./.test(n) || /\/step_count\./.test(n) || /^step_count\./.test(n)) return 'step_count';
  if (n.includes('sleep_stage')) return 'sleep_stage';
  if (/shealth\.sleep\.\d|health\.sleep\.\d/.test(n) && !/combined|goal|data|snoring/.test(n)) return 'sleep';
  if (/health\.weight\.\d/.test(n)) return 'weight';
  return null;
}

export function importSamsung(files: readonly CsvFile[]): SamsungImport {
  const out: SamsungImport = { steps: {}, sleep: {}, weights: {}, report: [] };
  const stepsBy: Partial<Record<Kind, Record<string, number>>> = {};
  const sessions = new Map<string, { date: string }>();
  const stageRows: { id: string; stage: string; min: number }[] = [];

  for (const f of files) {
    const kind = kindOf(f.name);
    if (!kind) continue;
    const t = readTable(f.text);
    if (!t) {
      out.report.push(`${f.name}: no se reconoció el encabezado.`);
      continue;
    }
    const { cols, rows } = t;
    let used = 0;
    if (kind === 'daily_trend' || kind === 'pedometer') {
      const countCol = kind === 'daily_trend' ? (cols.has('count') ? 'count' : 'step_count') : cols.has('step_count') ? 'step_count' : 'count';
      const m: Record<string, number> = (stepsBy[kind] ??= {});
      for (const r of rows) {
        const day = dayOf(cell(r, cols, 'day_time'));
        const c = numOf(cell(r, cols, countCol));
        if (day && c !== null && c >= 0) {
          m[day] = Math.max(m[day] ?? 0, Math.round(c)); // varias fuentes (reloj/teléfono): el máximo evita duplicar
          used++;
        }
      }
    } else if (kind === 'step_count') {
      const m: Record<string, number> = (stepsBy.step_count ??= {});
      for (const r of rows) {
        const e = toEpoch(cell(r, cols, 'start_time'));
        const c = numOf(cell(r, cols, 'count'));
        if (e !== null && c !== null && c >= 0) {
          const day = localYmd(e, offsetMs(cell(r, cols, 'time_offset')));
          m[day] = (m[day] ?? 0) + Math.round(c);
          used++;
        }
      }
    } else if (kind === 'sleep') {
      for (const r of rows) {
        const s = toEpoch(cell(r, cols, 'start_time'));
        const e = toEpoch(cell(r, cols, 'end_time'));
        const dur = numOf(cell(r, cols, 'sleep_duration'));
        const min = s !== null && e !== null && e > s ? Math.round((e - s) / 60_000) : dur;
        if (e === null || min === null || min <= 0 || min > 24 * 60) continue;
        const date = localYmd(e, offsetMs(cell(r, cols, 'time_offset')));
        const cur = out.sleep[date] ?? { min: 0 };
        cur.min += min;
        out.sleep[date] = cur;
        const id = cell(r, cols, 'datauuid') ?? cell(r, cols, 'sleep_id');
        if (id) sessions.set(id, { date });
        used++;
      }
    } else if (kind === 'sleep_stage') {
      for (const r of rows) {
        const s = toEpoch(cell(r, cols, 'start_time'));
        const e = toEpoch(cell(r, cols, 'end_time'));
        const id = cell(r, cols, 'sleep_id');
        const stage = cell(r, cols, 'stage');
        if (s !== null && e !== null && e > s && id && stage) {
          stageRows.push({ id, stage, min: (e - s) / 60_000 });
          used++;
        }
      }
    } else if (kind === 'weight') {
      for (const r of rows) {
        const e = toEpoch(cell(r, cols, 'start_time')) ?? toEpoch(cell(r, cols, 'create_time'));
        const kg = numOf(cell(r, cols, 'weight'));
        if (e === null || kg === null || kg < 20 || kg > 400) continue;
        const date = localYmd(e, offsetMs(cell(r, cols, 'time_offset')));
        const bf = numOf(cell(r, cols, 'body_fat'));
        out.weights[date] = { kg: Math.round(kg * 10) / 10, bodyFat: bf !== null && bf >= 3 && bf <= 60 ? Math.round(bf * 10) / 10 : null };
        used++;
      }
    }
    out.report.push(`${f.name}: ${used} filas útiles (${kind}).`);
  }

  // Pasos: preferir el resumen diario unificado; el conteo por intervalos puede duplicar reloj y teléfono.
  const pick = stepsBy.daily_trend ?? stepsBy.pedometer ?? stepsBy.step_count;
  if (pick) {
    out.steps = pick;
    const src = stepsBy.daily_trend ? 'step_daily_trend' : stepsBy.pedometer ? 'pedometer_day_summary' : 'step_count (suma por intervalos; puede duplicar fuentes)';
    out.report.push(`Pasos tomados de ${src}: ${Object.keys(pick).length} días.`);
  }

  // Etapas del sueño, asociadas a su sesión por sleep_id
  for (const r of stageRows) {
    const ses = sessions.get(r.id);
    const key = STAGE[r.stage];
    if (!ses || !key) continue;
    const d = out.sleep[ses.date];
    if (!d) continue;
    d.stages ??= { awake: 0, light: 0, deep: 0, rem: 0 };
    d.stages[key] += Math.round(r.min);
  }
  if (!files.some((f) => kindOf(f.name))) {
    out.report.push('No se encontró ningún archivo conocido (step_daily_trend, pedometer_day_summary, step_count, sleep, sleep_stage, weight).');
  }
  return out;
}
