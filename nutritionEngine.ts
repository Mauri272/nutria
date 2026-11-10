/**
 * nutritionEngine.ts — Motor metabólico y de objetivos.
 * TypeScript puro: sin I/O, sin dependencias, sin estado. Todas las funciones son deterministas.
 * Unidades: kg, cm, años, kcal, gramos.
 *
 * Base científica (supuestos y límites: ARCHITECTURE.md §6):
 *  - BMR: Mifflin–St Jeor; con % de grasa corporal, Katch–McArdle (sobre masa libre de grasa).
 *  - Ritmos de cambio: Iraki et al. 2019 (volumen) y Helms et al. 2014 (definición).
 *  - Proteína: Morton et al. 2018 (1.6 g/kg, IC hasta 2.2) y Helms et al. 2014 (2.3–3.1 g/kg FFM en déficit).
 *  - Grasas 20–30 % de las kcal con mínimo 0.6–0.8 g/kg; fibra 14 g por 1000 kcal.
 * Las constantes marcadas "heurística" son decisiones de diseño, no resultados publicados.
 */

// ───────────────────────────── Tipos ─────────────────────────────

export type Sex = 'male' | 'female';
export type Experience = 'beginner' | 'intermediate' | 'advanced';
export type Goal = 'gain' | 'lose' | 'maintain';
export type Horizon = 'short' | 'medium' | 'long';
export type BmrMethod = 'mifflin-st-jeor' | 'katch-mcardle';

export interface BodyProfile {
  sex: Sex;
  /** Años cumplidos (18–100: las fórmulas están validadas en adultos). */
  age: number;
  heightCm: number;
  weightKg: number;
  /** 3–60. Si viene, el BMR usa Katch–McArdle. */
  bodyFatPct?: number | undefined;
}

export type EngineErrorCode = 'OUT_OF_RANGE' | 'INCONSISTENT_TARGET';

export class NutritionEngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'NutritionEngineError';
    this.code = code;
  }
}

export type EngineWarning =
  | 'KCAL_FLOOR_APPLIED' //  el déficit se recortó para no bajar del piso calórico
  | 'RATE_CAPPED' //          se alcanzó el tope de ritmo (% de peso corporal por semana)
  | 'HORIZON_EXTENDED' //     el plazo pedido exigía un ritmo no permitido; se alargó
  | 'MACRO_BUDGET_TIGHT'; //  proteína + grasa mínima no caben en las kcal objetivo

// ─────────────────────────── Constantes ───────────────────────────

/** Energía por kg de masa corporal ganada/perdida (aprox. clásica; se usa para convertir ritmo ⇄ kcal/día). */
export const KCAL_PER_KG_BODY_MASS = 7700;
export const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 } as const;
export const PAL_MIN = 1.2;
export const PAL_MAX = 1.9;
export const FIBER_G_PER_1000_KCAL = 14;

/** PAL del "piso sedentario" usado en modo pasos (ya incluye TMB + efecto térmico + movimiento mínimo). */
export const DEFAULT_BASELINE_PAL = 1.2;
/** Heurística: pasos de vida sedentaria ya contenidos en el PAL base; evita contarlos dos veces. */
export const DEFAULT_BASELINE_STEPS = 3000;
/** Costo energético NETO de caminar en llano: 0.1 ml O2/kg/m (ACSM) × 5 kcal/L O2 = 0.5 kcal/kg/km. */
export const NET_WALK_KCAL_PER_KG_KM = 0.5;
/** Heurística: largo de paso ≈ 0.415 × estatura. */
export const STEP_LENGTH_PER_HEIGHT = 0.415;

// ───────────────────────── Utilidades internas ─────────────────────────

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new NutritionEngineError(
      'OUT_OF_RANGE',
      `${name} debe estar entre ${min} y ${max} (recibido: ${value}).`,
    );
  }
}

function assertProfile(p: Pick<BodyProfile, 'age' | 'heightCm' | 'weightKg'>): void {
  assertRange('age', p.age, 18, 100);
  assertRange('heightCm', p.heightCm, 120, 230);
  assertRange('weightKg', p.weightKg, 30, 300);
}

// ───────────────────────────── 1) BMR ─────────────────────────────

export interface BmrResult {
  kcal: number;
  method: BmrMethod;
  /** Masa libre de grasa (kg) si se conoce el % de grasa; si no, null. */
  ffmKg: number | null;
}

export function fatFreeMassKg(weightKg: number, bodyFatPct: number): number {
  assertRange('bodyFatPct', bodyFatPct, 3, 60);
  return weightKg * (1 - bodyFatPct / 100);
}

/** Mifflin–St Jeor: 10·kg + 6.25·cm − 5·edad + (5 hombre | −161 mujer). */
export function bmrMifflinStJeor(p: Pick<BodyProfile, 'sex' | 'age' | 'heightCm' | 'weightKg'>): number {
  assertProfile(p);
  return 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + (p.sex === 'male' ? 5 : -161);
}

/** Katch–McArdle: 370 + 21.6 · FFM(kg). */
export function bmrKatchMcArdle(ffmKg: number): number {
  assertRange('ffmKg', ffmKg, 15, 150);
  return 370 + 21.6 * ffmKg;
}

/** Katch–McArdle si hay % de grasa; si no, Mifflin–St Jeor. */
export function computeBmr(p: BodyProfile): BmrResult {
  assertProfile(p);
  if (p.bodyFatPct !== undefined) {
    const ffmKg = fatFreeMassKg(p.weightKg, p.bodyFatPct);
    return { kcal: bmrKatchMcArdle(ffmKg), method: 'katch-mcardle', ffmKg };
  }
  return { kcal: bmrMifflinStJeor(p), method: 'mifflin-st-jeor', ffmKg: null };
}

// ───────────────────────────── 2) TDEE ─────────────────────────────

/** Gasto neto por paso (kcal): 0.5 kcal/kg/km × kg × largo de paso (km). */
export function kcalPerStep(weightKg: number, heightCm: number): number {
  const stepLengthKm = (STEP_LENGTH_PER_HEIGHT * heightCm) / 100 / 1000;
  return NET_WALK_KCAL_PER_KG_KM * weightKg * stepLengthKm;
}

/** Gasto de los pasos por encima del piso sedentario (kcal). Nunca negativo. */
export function stepsExpenditureKcal(
  steps: number,
  weightKg: number,
  heightCm: number,
  baselineSteps: number = DEFAULT_BASELINE_STEPS,
): number {
  assertRange('steps', steps, 0, 100_000);
  assertRange('baselineSteps', baselineSteps, 0, 10_000);
  return Math.max(0, steps - baselineSteps) * kcalPerStep(weightKg, heightCm);
}

/**
 * Modelo de actividad. Son EXCLUYENTES a propósito, para no contar dos veces la caminata:
 *  - 'pal':   TDEE = BMR × PAL (1.2–1.9). Ignora los pasos.
 *  - 'steps': TDEE = BMR × PAL base (≤ 1.4) + gasto neto de pasos + kcal de entrenamiento.
 */
export type ActivityModel =
  | { kind: 'pal'; pal: number }
  | {
      kind: 'steps';
      /** Pasos del día (consolidados, p. ej. Health Connect `aggregate`). */
      steps: number;
      baselinePal?: number | undefined;
      baselineSteps?: number | undefined;
      /** kcal netas de entrenamiento del día (pesas, cardio), si se conocen. */
      exerciseKcal?: number | undefined;
    };

export interface TdeeResult {
  kcal: number;
  bmrKcal: number;
  bmrMethod: BmrMethod;
  model: 'pal' | 'steps';
  components: { base: number; steps: number; exercise: number };
}

export function computeTdee(profile: BodyProfile, activity: ActivityModel): TdeeResult {
  const bmr = computeBmr(profile);
  if (activity.kind === 'pal') {
    assertRange('pal', activity.pal, PAL_MIN, PAL_MAX);
    const base = bmr.kcal * activity.pal;
    return {
      kcal: base,
      bmrKcal: bmr.kcal,
      bmrMethod: bmr.method,
      model: 'pal',
      components: { base, steps: 0, exercise: 0 },
    };
  }
  const baselinePal = activity.baselinePal ?? DEFAULT_BASELINE_PAL;
  assertRange('baselinePal (modo pasos: sedentario, para no duplicar la caminata)', baselinePal, PAL_MIN, 1.4);
  const exercise = activity.exerciseKcal ?? 0;
  assertRange('exerciseKcal', exercise, 0, 3000);
  const base = bmr.kcal * baselinePal;
  const steps = stepsExpenditureKcal(
    activity.steps,
    profile.weightKg,
    profile.heightCm,
    activity.baselineSteps ?? DEFAULT_BASELINE_STEPS,
  );
  return {
    kcal: base + steps + exercise,
    bmrKcal: bmr.kcal,
    bmrMethod: bmr.method,
    model: 'steps',
    components: { base, steps, exercise },
  };
}

// ───────────── 3) Objetivo calórico por ritmo semanal y plazo ─────────────

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** kg/semana → kcal/día, con la equivalencia KCAL_PER_KG_BODY_MASS. */
export function weeklyKgToDailyKcal(weeklyKg: number): number {
  return (weeklyKg * KCAL_PER_KG_BODY_MASS) / 7;
}

/** kcal/día → kg/semana. */
export function dailyKcalToWeeklyKg(dailyKcal: number): number {
  return (dailyKcal * 7) / KCAL_PER_KG_BODY_MASS;
}

/** Heurística: semanas por plazo. El llamador puede pasar `weeks` explícito. */
export const HORIZON_WEEKS: Readonly<Record<Horizon, number>> = { short: 8, medium: 16, long: 32 };

/** Posición dentro de la ventana [min, max]: corto = más agresivo, largo = más conservador. */
const HORIZON_POSITION: Readonly<Record<Horizon, number>> = { short: 1, medium: 0.5, long: 0 };

/** Tope de ritmo, % de peso corporal/semana: 0.5 ganancia (Iraki 2019), 1.0 pérdida (Helms 2014). */
export const MAX_RATE_PCT_BW: Readonly<Record<'gain' | 'lose', number>> = { gain: 0.5, lose: 1.0 };

export interface EnergyWindow {
  /** Fracciones del TDEE (0.10 = 10 %). */
  minPct: number;
  maxPct: number;
}

/**
 * Ventana de superávit/déficit como fracción del TDEE (tu especificación):
 *  - gain: 5 %–10 %; el tope depende de la experiencia (principiante 10 %, intermedio 7.5 %, avanzado 5 %).
 *  - lose: 15 %–25 %, sin distinción por experiencia.
 * Nota: Iraki 2019 sugiere ~10–20 % de superávit para novatos/intermedios; si lo quieres, sube maxPct aquí.
 */
export function energyWindow(goal: Goal, experience: Experience): EnergyWindow {
  switch (goal) {
    case 'maintain':
      return { minPct: 0, maxPct: 0 };
    case 'lose':
      return { minPct: 0.15, maxPct: 0.25 };
    case 'gain': {
      const maxPct = { beginner: 0.1, intermediate: 0.075, advanced: 0.05 }[experience];
      return { minPct: 0.05, maxPct };
    }
  }
}

/** Piso calórico en déficit (convención habitual de guías/apps; ajustable): max(1500 H | 1200 M, BMR). */
export function minKcalFloor(sex: Sex, bmrKcal: number): number {
  return Math.max(sex === 'male' ? 1500 : 1200, bmrKcal);
}

export type LimitedBy = 'none' | 'tdee_window' | 'rate_cap' | 'kcal_floor';

export interface EnergyPlanRequest {
  tdeeKcal: number;
  bmrKcal: number;
  weightKg: number;
  sex: Sex;
  goal: Goal;
  experience: Experience;
  horizon: Horizon;
  /** Con peso objetivo, el ritmo se deriva de (objetivo − actual) / semanas. Sin él, lo fija el plazo. */
  targetWeightKg?: number | undefined;
  /** Semanas del plan; por defecto HORIZON_WEEKS[horizon]. */
  weeks?: number | undefined;
}

export interface EnergyPlan {
  goal: Goal;
  targetKcal: number;
  /** + superávit / − déficit (kcal/día). */
  dailyDeltaKcal: number;
  /** |delta| / TDEE, como fracción. */
  pctOfTdee: number;
  /** Con signo. */
  weeklyKg: number;
  /** Con signo, en % del peso corporal. */
  weeklyPctBodyWeight: number;
  /** Semanas hasta el peso objetivo al ritmo logrado, o la duración del plazo si no hay objetivo. */
  weeks: number;
  projectedWeightKg: number;
  /** Qué restricción fue la que mandó (útil para explicarlo en la UI). */
  limitedBy: LimitedBy;
  warnings: EngineWarning[];
}

/**
 * Convierte meta + plazo (+ peso objetivo opcional) en un objetivo calórico diario.
 * Restricciones, de la más suave a la más dura: ventana %TDEE → tope de ritmo %peso/semana → piso calórico.
 * Un ritmo MÁS LENTO que la ventana se respeta (el mínimo es orientativo; el máximo es el límite de seguridad).
 */
export function planEnergyTarget(req: EnergyPlanRequest): EnergyPlan {
  const { tdeeKcal, bmrKcal, weightKg, sex, goal, experience, horizon, targetWeightKg } = req;
  assertRange('tdeeKcal', tdeeKcal, 800, 8000);
  assertRange('bmrKcal', bmrKcal, 500, 5000);
  assertRange('weightKg', weightKg, 30, 300);
  const plannedWeeks = req.weeks ?? HORIZON_WEEKS[horizon];
  assertRange('weeks', plannedWeeks, 1, 104);
  const warnings: EngineWarning[] = [];

  if (goal === 'maintain') {
    return {
      goal,
      targetKcal: Math.round(tdeeKcal),
      dailyDeltaKcal: 0,
      pctOfTdee: 0,
      weeklyKg: 0,
      weeklyPctBodyWeight: 0,
      weeks: plannedWeeks,
      projectedWeightKg: weightKg,
      limitedBy: 'none',
      warnings,
    };
  }

  const sign = goal === 'gain' ? 1 : -1;
  const win = energyWindow(goal, experience);

  let pct: number;
  if (targetWeightKg !== undefined) {
    assertRange('targetWeightKg', targetWeightKg, 30, 300);
    const diff = targetWeightKg - weightKg;
    if (sign * diff <= 0) {
      throw new NutritionEngineError(
        'INCONSISTENT_TARGET',
        `El peso objetivo (${targetWeightKg} kg) no es coherente con la meta "${goal}" desde ${weightKg} kg.`,
      );
    }
    pct = weeklyKgToDailyKcal(Math.abs(diff) / plannedWeeks) / tdeeKcal;
  } else {
    pct = win.minPct + HORIZON_POSITION[horizon] * (win.maxPct - win.minPct);
  }

  let limitedBy: LimitedBy = 'none';
  if (pct > win.maxPct) {
    pct = win.maxPct;
    limitedBy = 'tdee_window';
  }

  const ratePctBw = (dailyKcalToWeeklyKg(pct * tdeeKcal) / weightKg) * 100;
  const rateCap = MAX_RATE_PCT_BW[goal];
  if (ratePctBw > rateCap) {
    pct *= rateCap / ratePctBw;
    limitedBy = 'rate_cap';
    warnings.push('RATE_CAPPED');
  }

  let delta = sign * pct * tdeeKcal;
  let targetKcal = tdeeKcal + delta;
  if (goal === 'lose') {
    const floor = minKcalFloor(sex, bmrKcal);
    if (targetKcal < floor) {
      targetKcal = Math.min(tdeeKcal, floor); // si el TDEE ya está bajo el piso, no se prescribe déficit
      delta = targetKcal - tdeeKcal;
      limitedBy = 'kcal_floor';
      warnings.push('KCAL_FLOOR_APPLIED');
    }
  }

  const weeklyKg = dailyKcalToWeeklyKg(delta);
  const reachesTarget = targetWeightKg !== undefined && weeklyKg !== 0;
  const weeks =
    targetWeightKg !== undefined && weeklyKg !== 0
      ? Math.abs(targetWeightKg - weightKg) / Math.abs(weeklyKg)
      : plannedWeeks;
  if (reachesTarget && weeks > plannedWeeks * 1.001) warnings.push('HORIZON_EXTENDED');

  return {
    goal,
    targetKcal: Math.round(targetKcal),
    dailyDeltaKcal: Math.round(delta),
    pctOfTdee: round2(Math.abs(delta) / tdeeKcal),
    weeklyKg: round2(weeklyKg),
    weeklyPctBodyWeight: round2((weeklyKg / weightKg) * 100),
    weeks: round1(weeks),
    projectedWeightKg:
      targetWeightKg !== undefined && reachesTarget ? targetWeightKg : round1(weightKg + weeklyKg * weeks),
    limitedBy,
    warnings,
  };
}

// ───────────────────── 4) Macronutrientes y fibra ─────────────────────

/** Proteína por kg de peso corporal total (Morton 2018: 1.6 g/kg, IC hasta 2.2). */
export const PROTEIN_G_PER_KG_BW = { min: 1.6, max: 2.2, defaultGainMaintain: 1.8, defaultLose: 2.2 } as const;
/** Proteína por kg de masa libre de grasa en déficits marcados (Helms 2014). */
export const PROTEIN_G_PER_KG_FFM_DEFICIT = { min: 2.3, max: 3.1 } as const;
export const FAT_PCT_RANGE = { min: 0.2, max: 0.3, default: 0.25 } as const;
/** Grasa mínima por kg de peso (salud hormonal): 0.8 preferido; 0.6 solo si el presupuesto no alcanza. */
export const FAT_G_PER_KG_MIN = { preferred: 0.8, absolute: 0.6 } as const;

/** Fibra objetivo para un nivel de energía dado: 14 g por 1000 kcal. */
export function fiberTargetG(kcal: number): number {
  assertRange('kcal', kcal, 0, 10_000);
  return (FIBER_G_PER_1000_KCAL * kcal) / 1000;
}

export interface MacroRequest {
  goal: Goal;
  weightKg: number;
  /** Masa libre de grasa, si se conoce; habilita la proteína por FFM en déficit. */
  ffmKg?: number | undefined;
  targetKcal: number;
  /** Para medir la severidad del déficit. */
  tdeeKcal: number;
  /** 0.20–0.30 (por defecto 0.25). */
  fatPct?: number | undefined;
  /** Anula el cálculo automático de proteína (1.2–3.5 g/kg de peso total). */
  proteinGPerKg?: number | undefined;
}

export interface MacroPlan {
  /** Energía realmente asignada por los macros (≈ targetKcal; difiere si el presupuesto no alcanzó). */
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  proteinGPerKg: number;
  fatGPerKg: number;
  carbsGPerKg: number;
  /** Fracciones de la energía (0–1). */
  pctKcal: { protein: number; carbs: number; fat: number };
  proteinBasis: 'total-bodyweight' | 'fat-free-mass' | 'user-override';
  warnings: EngineWarning[];
}

/**
 * Prioridad: 1) proteína, 2) grasa (≥ mínimo g/kg), 3) carbohidratos = resto, 4) fibra aparte.
 * Los carbohidratos del plan se tratan como disponibles (la fibra no se descuenta de ellos).
 */
export function computeMacros(req: MacroRequest): MacroPlan {
  const { goal, weightKg, ffmKg, targetKcal, tdeeKcal } = req;
  assertRange('weightKg', weightKg, 30, 300);
  assertRange('targetKcal', targetKcal, 800, 8000);
  assertRange('tdeeKcal', tdeeKcal, 800, 8000);
  const fatPct = req.fatPct ?? FAT_PCT_RANGE.default;
  assertRange('fatPct', fatPct, FAT_PCT_RANGE.min, FAT_PCT_RANGE.max);
  if (ffmKg !== undefined) assertRange('ffmKg', ffmKg, 15, 150);
  const warnings: EngineWarning[] = [];

  // 1) Proteína
  const minProteinG = PROTEIN_G_PER_KG_BW.min * weightKg;
  let proteinG: number;
  let proteinBasis: MacroPlan['proteinBasis'] = 'total-bodyweight';
  if (req.proteinGPerKg !== undefined) {
    assertRange('proteinGPerKg', req.proteinGPerKg, 1.2, 3.5);
    proteinG = req.proteinGPerKg * weightKg;
    proteinBasis = 'user-override';
  } else if (goal === 'lose' && ffmKg !== undefined) {
    // Heurística: rampa lineal por severidad del déficit, 15 % → 2.3 g/kg FFM; ≥ 25 % → 3.1 g/kg FFM.
    const deficitPct = Math.max(0, (tdeeKcal - targetKcal) / tdeeKcal);
    const severity = clamp((deficitPct - 0.15) / 0.1, 0, 1);
    const { min, max } = PROTEIN_G_PER_KG_FFM_DEFICIT;
    proteinG = Math.max(minProteinG, (min + (max - min) * severity) * ffmKg);
    proteinBasis = 'fat-free-mass';
  } else if (goal === 'lose') {
    proteinG = PROTEIN_G_PER_KG_BW.defaultLose * weightKg;
  } else {
    proteinG = PROTEIN_G_PER_KG_BW.defaultGainMaintain * weightKg;
  }

  // 2) Grasa y 3) carbohidratos (con degradación ordenada si el presupuesto no alcanza)
  let fatG = Math.max((fatPct * targetKcal) / KCAL_PER_G.fat, FAT_G_PER_KG_MIN.preferred * weightKg);
  let carbsG = (targetKcal - KCAL_PER_G.protein * proteinG - KCAL_PER_G.fat * fatG) / KCAL_PER_G.carbs;
  if (carbsG < 0) {
    warnings.push('MACRO_BUDGET_TIGHT');
    fatG = FAT_G_PER_KG_MIN.absolute * weightKg;
    carbsG = (targetKcal - KCAL_PER_G.protein * proteinG - KCAL_PER_G.fat * fatG) / KCAL_PER_G.carbs;
    if (carbsG < 0) {
      const affordable = (targetKcal - KCAL_PER_G.fat * fatG) / KCAL_PER_G.protein;
      proteinG = Math.min(proteinG, Math.max(minProteinG, affordable));
      carbsG = (targetKcal - KCAL_PER_G.protein * proteinG - KCAL_PER_G.fat * fatG) / KCAL_PER_G.carbs;
    }
  }

  const protein = Math.round(proteinG);
  const fat = Math.round(fatG);
  const carbs = Math.max(0, Math.round((targetKcal - KCAL_PER_G.protein * protein - KCAL_PER_G.fat * fat) / KCAL_PER_G.carbs));
  const kcal = KCAL_PER_G.protein * protein + KCAL_PER_G.carbs * carbs + KCAL_PER_G.fat * fat;

  return {
    kcal,
    proteinG: protein,
    carbsG: carbs,
    fatG: fat,
    fiberG: Math.round(fiberTargetG(targetKcal)),
    proteinGPerKg: round2(protein / weightKg),
    fatGPerKg: round2(fat / weightKg),
    carbsGPerKg: round2(carbs / weightKg),
    pctKcal: {
      protein: round2((KCAL_PER_G.protein * protein) / kcal),
      carbs: round2((KCAL_PER_G.carbs * carbs) / kcal),
      fat: round2((KCAL_PER_G.fat * fat) / kcal),
    },
    proteinBasis,
    warnings,
  };
}

// ─────────────────────────── 5) Orquestador ───────────────────────────

export interface NutritionPlanRequest {
  profile: BodyProfile;
  activity: ActivityModel;
  goal: Goal;
  experience: Experience;
  horizon: Horizon;
  targetWeightKg?: number | undefined;
  weeks?: number | undefined;
  fatPct?: number | undefined;
  proteinGPerKg?: number | undefined;
}

export interface NutritionPlan {
  bmr: BmrResult;
  tdee: TdeeResult;
  energy: EnergyPlan;
  macros: MacroPlan;
  warnings: EngineWarning[];
}

/** Perfil + actividad + meta → BMR, TDEE, objetivo calórico y macros en una sola llamada. */
export function buildNutritionPlan(req: NutritionPlanRequest): NutritionPlan {
  const bmr = computeBmr(req.profile);
  const tdee = computeTdee(req.profile, req.activity);
  const energy = planEnergyTarget({
    tdeeKcal: tdee.kcal,
    bmrKcal: bmr.kcal,
    weightKg: req.profile.weightKg,
    sex: req.profile.sex,
    goal: req.goal,
    experience: req.experience,
    horizon: req.horizon,
    targetWeightKg: req.targetWeightKg,
    weeks: req.weeks,
  });
  const macros = computeMacros({
    goal: req.goal,
    weightKg: req.profile.weightKg,
    ffmKg: bmr.ffmKg ?? undefined,
    targetKcal: energy.targetKcal,
    tdeeKcal: tdee.kcal,
    fatPct: req.fatPct,
    proteinGPerKg: req.proteinGPerKg,
  });
  return { bmr, tdee, energy, macros, warnings: [...new Set([...energy.warnings, ...macros.warnings])] };
}
