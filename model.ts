/** Modelo de datos de la app, persistencia local y cálculos puros (totales, EMA, tendencias). */
import {
  buildNutritionPlan,
  NutritionEngineError,
  type ActivityModel,
  type Experience,
  type Goal,
  type Horizon,
  type NutritionPlan,
  type Sex,
} from '../../../src/domain/nutritionEngine';
import { addDays, daysBetween, localDate, round1, weekStart } from './util';

export const SLOTS = [
  { id: 'desayuno', label: 'Desayuno' },
  { id: 'almuerzo', label: 'Almuerzo' },
  { id: 'once', label: 'Once / Merienda' },
  { id: 'cena', label: 'Cena' },
  { id: 'snacks', label: 'Snacks' },
  { id: 'entreno', label: 'Pre / Post-Entreno' },
] as const;
export type SlotId = (typeof SLOTS)[number]['id'];

export interface Per100 {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number | null;
  sodium: number | null;
}
export interface Food {
  id: string;
  name: string;
  brand: string | null;
  barcode: string | null;
  source: 'off' | 'user' | 'recipe';
  per100: Per100;
  servingG: number | null;
  createdAt: number;
}
export interface RecipeIngredient {
  foodId: string;
  name: string;
  grams: number;
}
export interface Recipe {
  id: string;
  foodId: string; // el alimento derivado que se usa en el diario
  name: string;
  servings: number;
  ingredients: RecipeIngredient[];
}
export interface Entry {
  id: string;
  slot: SlotId;
  name: string;
  grams: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  foodId: string | null;
  ts: number;
}
export interface Target {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
}
export interface Day {
  entries: Entry[];
  target?: Target;
  steps?: number;
  sleepMin?: number;
  sleepStages?: { awake: number; light: number; deep: number; rem: number };
}
export interface Profile {
  sex: Sex;
  age: number;
  heightCm: number;
  weightKg: number;
  bodyFatPct: number | null;
  experience: Experience;
  goal: Goal;
  horizon: Horizon;
  targetWeightKg: number | null;
  activity: 'pal' | 'steps';
  pal: number;
}
export const MEASURE_KEYS = [
  ['neck', 'Cuello'],
  ['shoulders', 'Hombros'],
  ['chest', 'Pecho'],
  ['waist', 'Cintura'],
  ['hips', 'Cadera'],
  ['biceps', 'Bíceps'],
  ['thighs', 'Muslos'],
] as const;
export type MeasureKey = (typeof MEASURE_KEYS)[number][0];

export interface AppData {
  v: 1;
  profile: Profile | null;
  foods: Record<string, Food>;
  recipes: Record<string, Recipe>;
  days: Record<string, Day>;
  weights: Record<string, number>;
  measures: Record<string, Partial<Record<MeasureKey, number>>>;
}

export function emptyData(): AppData {
  return { v: 1, profile: null, foods: {}, recipes: {}, days: {}, weights: {}, measures: {} };
}

// ───────────── Persistencia (localStorage con respaldo en memoria) ─────────────
const KEY = 'nutriapp.v1';
let memory: string | null = null;
let persistent = true;

export function loadData(): AppData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch {
    persistent = false;
  }
  return memory ? migrate(JSON.parse(memory)) : emptyData();
}

export function saveData(d: AppData): boolean {
  const raw = JSON.stringify(d);
  memory = raw;
  try {
    localStorage.setItem(KEY, raw);
    return true;
  } catch {
    persistent = false;
    return false;
  }
}
export function isPersistent(): boolean {
  return persistent;
}

/** Valida/rellena un JSON (de localStorage o de un respaldo importado). Lanza si no es un respaldo válido. */
export function migrate(x: unknown): AppData {
  if (typeof x !== 'object' || x === null) throw new Error('Respaldo inválido.');
  const o = x as Partial<AppData>;
  if (o.v !== 1) throw new Error('Versión de respaldo no reconocida.');
  const base = emptyData();
  return {
    v: 1,
    profile: o.profile ?? null,
    foods: o.foods ?? base.foods,
    recipes: o.recipes ?? base.recipes,
    days: o.days ?? base.days,
    weights: o.weights ?? base.weights,
    measures: o.measures ?? base.measures,
  };
}

// ───────────── Alimentos y totales ─────────────
export function portion(per100: Per100, grams: number) {
  const k = grams / 100;
  return {
    kcal: round1(per100.kcal * k),
    protein: round1(per100.protein * k),
    carbs: round1(per100.carbs * k),
    fat: round1(per100.fat * k),
    fiber: round1((per100.fiber ?? 0) * k),
  };
}

export function sumEntries(entries: readonly Entry[]) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const e of entries) {
    t.kcal += e.kcal;
    t.protein += e.protein;
    t.carbs += e.carbs;
    t.fat += e.fat;
    t.fiber += e.fiber;
  }
  return { kcal: round1(t.kcal), protein: round1(t.protein), carbs: round1(t.carbs), fat: round1(t.fat), fiber: round1(t.fiber) };
}

/** Receta → totales, por 100 g (peso = suma de ingredientes) y por porción. */
export function recipeNutrition(ings: readonly RecipeIngredient[], foods: Record<string, Food>, servings: number) {
  let grams = 0;
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0 };
  let sodiumKnown = true;
  for (const i of ings) {
    const f = foods[i.foodId];
    if (!f || !(i.grams > 0)) continue;
    const p = portion(f.per100, i.grams);
    grams += i.grams;
    t.kcal += p.kcal;
    t.protein += p.protein;
    t.carbs += p.carbs;
    t.fat += p.fat;
    t.fiber += p.fiber;
    if (f.per100.sodium === null) sodiumKnown = false;
    else t.sodium += (f.per100.sodium * i.grams) / 100;
  }
  const per100: Per100 =
    grams > 0
      ? {
          kcal: round1((t.kcal * 100) / grams),
          protein: round1((t.protein * 100) / grams),
          carbs: round1((t.carbs * 100) / grams),
          fat: round1((t.fat * 100) / grams),
          fiber: round1((t.fiber * 100) / grams),
          sodium: sodiumKnown ? round1((t.sodium * 100) / grams) : null,
        }
      : { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: null };
  const s = Math.max(1, servings);
  return {
    grams: round1(grams),
    total: { kcal: round1(t.kcal), protein: round1(t.protein), carbs: round1(t.carbs), fat: round1(t.fat), fiber: round1(t.fiber) },
    per100,
    perServing: { grams: round1(grams / s), kcal: round1(t.kcal / s), protein: round1(t.protein / s), carbs: round1(t.carbs / s), fat: round1(t.fat / s) },
  };
}

// ───────────── Plan (motor) ─────────────
export function latestWeight(d: AppData): number | null {
  const dates = Object.keys(d.weights).sort();
  const last = dates[dates.length - 1];
  return last ? (d.weights[last] ?? null) : null;
}

/** Promedio de pasos de los últimos 7 días con dato (hasta `today`); null si no hay. */
export function avgSteps7(d: AppData, today: string): number | null {
  const vals: number[] = [];
  for (let i = 0; i < 7; i++) {
    const s = d.days[addDays(today, -i)]?.steps;
    if (typeof s === 'number' && s > 0) vals.push(s);
  }
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}

export interface PlanResult {
  plan: NutritionPlan;
  target: Target;
  usedModel: 'pal' | 'steps';
  note: string | null;
}

export function computePlan(d: AppData, today: string): PlanResult | { error: string } | null {
  const p = d.profile;
  if (!p) return null;
  const weightKg = latestWeight(d) ?? p.weightKg;
  let activity: ActivityModel = { kind: 'pal', pal: p.pal };
  let note: string | null = null;
  if (p.activity === 'steps') {
    const s = avgSteps7(d, today);
    if (s === null) note = 'Sin datos de pasos de los últimos 7 días: se usó el nivel de actividad (PAL).';
    else activity = { kind: 'steps', steps: s };
  }
  try {
    const plan = buildNutritionPlan({
      profile: { sex: p.sex, age: p.age, heightCm: p.heightCm, weightKg, bodyFatPct: p.bodyFatPct ?? undefined },
      activity,
      goal: p.goal,
      experience: p.experience,
      horizon: p.horizon,
      targetWeightKg: p.targetWeightKg ?? undefined,
    });
    const m = plan.macros;
    return {
      plan,
      usedModel: activity.kind,
      note,
      target: { kcal: Math.round(plan.energy.targetKcal), protein: Math.round(m.proteinG), carbs: Math.round(m.carbsG), fat: Math.round(m.fatG), fiber: Math.round(m.fiberG) },
    };
  } catch (e) {
    return { error: e instanceof NutritionEngineError || e instanceof Error ? e.message : String(e) };
  }
}

// ───────────── Tendencia de peso (EMA de 7 días) ─────────────
export interface WeightPoint {
  date: string;
  w: number;
  ema: number;
}

/** EMA con α = 2/(N+1), N = 7. Se actualiza solo en días con pesaje; el primer valor inicializa la media. */
export function weightEma(weights: Record<string, number>, span = 7): WeightPoint[] {
  const alpha = 2 / (span + 1);
  const out: WeightPoint[] = [];
  let ema: number | null = null;
  for (const date of Object.keys(weights).sort()) {
    const w = weights[date] as number;
    ema = ema === null ? w : alpha * w + (1 - alpha) * ema;
    out.push({ date, w, ema: round1(ema * 100) / 100 });
  }
  return out;
}

/** Ritmo real (kg/semana) por regresión simple sobre la EMA de los últimos `windowDays`; null si hay < 7 días de rango. */
export function actualRateKgPerWeek(points: readonly WeightPoint[], windowDays = 21): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1] as WeightPoint;
  const win = points.filter((p) => daysBetween(p.date, last.date) <= windowDays);
  const first = win[0] as WeightPoint;
  const span = daysBetween(first.date, last.date);
  if (win.length < 3 || span < 7) return null;
  const xs = win.map((p) => daysBetween(first.date, p.date));
  const ys = win.map((p) => p.ema);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * ((ys[i] as number) - my);
    den += (x - mx) ** 2;
  });
  return den === 0 ? null : (num / den) * 7;
}

export interface WeekRow {
  start: string;
  avgKcal: number | null;
  loggedDays: number;
  deltaKg: number | null;
}

/** Por semana (lunes): ingesta media de los días con registro y cambio de la EMA respecto al cierre de la semana previa. */
export function weeklyTrend(d: AppData, weeks: number, today: string = localDate()): WeekRow[] {
  const pts = weightEma(d.weights);
  const emaAtOrBefore = (date: string): number | null => {
    let v: number | null = null;
    for (const p of pts) {
      if (p.date <= date) v = p.ema;
      else break;
    }
    return v;
  };
  const rows: WeekRow[] = [];
  const thisWeek = weekStart(today);
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(thisWeek, -7 * i);
    let sum = 0;
    let n = 0;
    for (let k = 0; k < 7; k++) {
      const day = d.days[addDays(start, k)];
      if (day && day.entries.length) {
        sum += sumEntries(day.entries).kcal;
        n++;
      }
    }
    const end = addDays(start, 6);
    const a = emaAtOrBefore(end);
    const b = emaAtOrBefore(addDays(start, -1));
    rows.push({ start, avgKcal: n ? Math.round(sum / n) : null, loggedDays: n, deltaKg: a !== null && b !== null && end <= today ? round1((a - b) * 10) / 10 : null });
  }
  return rows;
}
