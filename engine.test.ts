import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NutritionEngineError,
  bmrKatchMcArdle,
  bmrMifflinStJeor,
  buildNutritionPlan,
  computeBmr,
  computeMacros,
  computeTdee,
  dailyKcalToWeeklyKg,
  energyWindow,
  fiberTargetG,
  kcalPerStep,
  minKcalFloor,
  planEnergyTarget,
  stepsExpenditureKcal,
  weeklyKgToDailyKcal,
  type ActivityModel,
  type BodyProfile,
  type EnergyPlanRequest,
  type Experience,
  type Goal,
  type Horizon,
} from '../src/domain/nutritionEngine';

const close = (actual: number, expected: number, eps = 1e-9): void =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} no está a ${eps} de ${expected}`);

const outOfRange = (e: unknown): boolean => e instanceof NutritionEngineError && e.code === 'OUT_OF_RANGE';

const MALE: BodyProfile = { sex: 'male', age: 30, heightCm: 175, weightKg: 75 };

// ───────────────────────────── BMR ─────────────────────────────

describe('BMR', () => {
  it('Mifflin–St Jeor contra cálculo manual', () => {
    close(bmrMifflinStJeor(MALE), 1698.75); // 750 + 1093.75 − 150 + 5
    close(bmrMifflinStJeor({ sex: 'female', age: 28, heightCm: 165, weightKg: 60 }), 1330.25); // 600 + 1031.25 − 140 − 161
  });

  it('Katch–McArdle: 370 + 21.6 · FFM', () => {
    close(bmrKatchMcArdle(60), 1666);
  });

  it('computeBmr usa Katch–McArdle solo si hay % de grasa', () => {
    const katch = computeBmr({ ...MALE, bodyFatPct: 20 });
    assert.equal(katch.method, 'katch-mcardle');
    close(katch.ffmKg ?? 0, 60);
    close(katch.kcal, 1666);
    const mifflin = computeBmr(MALE);
    assert.equal(mifflin.method, 'mifflin-st-jeor');
    assert.equal(mifflin.ffmKg, null);
  });

  it('rechaza entradas fuera de rango (menores de edad, % de grasa imposible, NaN)', () => {
    assert.throws(() => bmrMifflinStJeor({ ...MALE, age: 17 }), outOfRange);
    assert.throws(() => bmrMifflinStJeor({ ...MALE, weightKg: 20 }), outOfRange);
    assert.throws(() => bmrMifflinStJeor({ ...MALE, heightCm: 90 }), outOfRange);
    assert.throws(() => bmrMifflinStJeor({ ...MALE, weightKg: Number.NaN }), outOfRange);
    assert.throws(() => computeBmr({ ...MALE, bodyFatPct: 70 }), outOfRange);
    assert.throws(() => computeBmr({ ...MALE, bodyFatPct: 1 }), outOfRange);
  });
});

// ───────────────────────────── TDEE ─────────────────────────────

describe('TDEE', () => {
  it('modo PAL: BMR × PAL', () => {
    const t = computeTdee(MALE, { kind: 'pal', pal: 1.55 });
    close(t.kcal, 2633.0625);
    assert.equal(t.model, 'pal');
    assert.deepEqual(t.components, { base: 2633.0625, steps: 0, exercise: 0 });
  });

  it('PAL fuera de 1.2–1.9 es inválido', () => {
    assert.throws(() => computeTdee(MALE, { kind: 'pal', pal: 1.1 }), outOfRange);
    assert.throws(() => computeTdee(MALE, { kind: 'pal', pal: 2.0 }), outOfRange);
  });

  it('gasto por paso: 0.5 kcal/kg/km × kg × (0.415 × estatura)', () => {
    close(kcalPerStep(75, 175), 0.027234375);
    close(stepsExpenditureKcal(10_000, 75, 175), 190.640625); // (10000 − 3000) pasos
    assert.equal(stepsExpenditureKcal(2000, 75, 175), 0); // bajo el piso sedentario no resta ni suma
    assert.throws(() => stepsExpenditureKcal(-1, 75, 175), outOfRange);
  });

  it('modo pasos: BMR × 1.2 + pasos + entrenamiento (sin duplicar la caminata)', () => {
    const t = computeTdee(MALE, { kind: 'steps', steps: 10_000, exerciseKcal: 200 });
    close(t.components.base, 2038.5);
    close(t.components.steps, 190.640625);
    close(t.components.exercise, 200);
    close(t.kcal, 2429.140625);
    assert.equal(t.model, 'steps');
  });

  it('modo pasos: el PAL base debe ser sedentario (≤ 1.4), si no se cuenta dos veces la caminata', () => {
    const bad: ActivityModel = { kind: 'steps', steps: 8000, baselinePal: 1.55 };
    assert.throws(() => computeTdee(MALE, bad), outOfRange);
  });

  it('con 10 000 pasos el TDEE queda entre el PAL 1.2 y el 1.55 (sanidad)', () => {
    const t = computeTdee(MALE, { kind: 'steps', steps: 10_000 });
    assert.ok(t.kcal > 1698.75 * 1.2 && t.kcal < 1698.75 * 1.55, String(t.kcal));
  });
});

// ─────────────────────── Ritmo semanal y objetivo calórico ───────────────────────

describe('ritmo semanal ⇄ kcal/día', () => {
  it('7700 kcal por kg: 0.5 kg/sem = 550 kcal/día, e inversa', () => {
    close(weeklyKgToDailyKcal(0.5), 550);
    close(dailyKcalToWeeklyKg(550), 0.5);
    close(dailyKcalToWeeklyKg(weeklyKgToDailyKcal(0.37)), 0.37);
  });

  it('la ventana de superávit depende de la experiencia; la de déficit no', () => {
    assert.deepEqual(energyWindow('gain', 'beginner'), { minPct: 0.05, maxPct: 0.1 });
    assert.deepEqual(energyWindow('gain', 'intermediate'), { minPct: 0.05, maxPct: 0.075 });
    assert.deepEqual(energyWindow('gain', 'advanced'), { minPct: 0.05, maxPct: 0.05 });
    assert.deepEqual(energyWindow('lose', 'beginner'), energyWindow('lose', 'advanced'));
    assert.deepEqual(energyWindow('maintain', 'beginner'), { minPct: 0, maxPct: 0 });
  });
});

describe('planEnergyTarget', () => {
  const BASE = { tdeeKcal: 2633.0625, bmrKcal: 1698.75, weightKg: 75, sex: 'male' } as const;
  const plan = (over: Partial<EnergyPlanRequest> & Pick<EnergyPlanRequest, 'goal' | 'experience' | 'horizon'>) =>
    planEnergyTarget({ ...BASE, ...over });

  it('mantenimiento: sin delta', () => {
    const p = plan({ goal: 'maintain', experience: 'intermediate', horizon: 'medium' });
    assert.equal(p.targetKcal, 2633);
    assert.equal(p.dailyDeltaKcal, 0);
    assert.equal(p.limitedBy, 'none');
  });

  it('volumen intermedio a plazo medio: 6.25 % del TDEE (punto medio de 5–7.5 %)', () => {
    const p = plan({ goal: 'gain', experience: 'intermediate', horizon: 'medium' });
    assert.equal(p.dailyDeltaKcal, 165); // 0.0625 × 2633.06 = 164.57
    assert.equal(p.targetKcal, 2798);
    assert.equal(p.limitedBy, 'none');
    assert.ok(p.weeklyPctBodyWeight > 0.1 && p.weeklyPctBodyWeight <= 0.5);
    assert.deepEqual(p.warnings, []);
  });

  it('el principiante sube más que el avanzado, y el plazo corto más que el largo', () => {
    const t = (experience: Experience, horizon: Horizon) => plan({ goal: 'gain', experience, horizon }).targetKcal;
    assert.equal(t('beginner', 'short'), 2896); // 10 %
    assert.equal(t('advanced', 'short'), 2765); // 5 %
    assert.ok(t('beginner', 'short') >= t('intermediate', 'short') && t('intermediate', 'short') >= t('advanced', 'short'));
    assert.ok(t('beginner', 'short') > t('beginner', 'medium') && t('beginner', 'medium') > t('beginner', 'long'));
  });

  it('déficit: 15 % (largo) a 25 % (corto) del TDEE', () => {
    const t = (horizon: Horizon) => plan({ goal: 'lose', experience: 'intermediate', horizon });
    assert.equal(t('short').targetKcal, 1975);
    assert.equal(t('short').dailyDeltaKcal, -658);
    assert.equal(t('long').targetKcal, 2238);
    assert.ok(t('short').weeklyPctBodyWeight >= -1 && t('short').weeklyPctBodyWeight < -0.5);
  });

  it('piso calórico: no baja de max(1500 H | 1200 M, BMR) y avisa', () => {
    close(minKcalFloor('male', 1698.75), 1698.75);
    assert.equal(minKcalFloor('female', 1100), 1200);
    const p = planEnergyTarget({ tdeeKcal: 2038.5, bmrKcal: 1698.75, weightKg: 75, sex: 'male', goal: 'lose', experience: 'intermediate', horizon: 'short' });
    assert.equal(p.targetKcal, 1699);
    assert.equal(p.dailyDeltaKcal, -340);
    assert.equal(p.limitedBy, 'kcal_floor');
    assert.deepEqual(p.warnings, ['KCAL_FLOOR_APPLIED']);
  });

  it('si el TDEE ya está bajo el piso no se prescribe déficit (ni se convierte en superávit)', () => {
    const p = planEnergyTarget({ tdeeKcal: 1400, bmrKcal: 1300, weightKg: 70, sex: 'male', goal: 'lose', experience: 'beginner', horizon: 'short' });
    assert.equal(p.targetKcal, 1400);
    assert.equal(p.dailyDeltaKcal, 0);
    assert.ok(p.warnings.includes('KCAL_FLOOR_APPLIED'));
  });

  it('tope de ritmo: pérdida máx. 1 %/sem y ganancia máx. 0.5 %/sem', () => {
    const lose = planEnergyTarget({ tdeeKcal: 2500, bmrKcal: 1300, weightKg: 50, sex: 'female', goal: 'lose', experience: 'intermediate', horizon: 'short' });
    assert.equal(lose.limitedBy, 'rate_cap');
    assert.equal(lose.dailyDeltaKcal, -550);
    assert.equal(lose.targetKcal, 1950);
    assert.equal(lose.weeklyPctBodyWeight, -1);
    assert.ok(lose.warnings.includes('RATE_CAPPED'));

    const gain = planEnergyTarget({ tdeeKcal: 4000, bmrKcal: 1300, weightKg: 50, sex: 'male', goal: 'gain', experience: 'beginner', horizon: 'short' });
    assert.equal(gain.limitedBy, 'rate_cap');
    assert.equal(gain.dailyDeltaKcal, 275);
    assert.equal(gain.weeklyPctBodyWeight, 0.5);
  });

  it('con peso objetivo: respeta el plazo si es viable', () => {
    const p = plan({ goal: 'gain', experience: 'intermediate', horizon: 'medium', targetWeightKg: 77 }); // +2 kg en 16 sem
    assert.equal(p.limitedBy, 'none');
    assert.equal(p.dailyDeltaKcal, 138); // 137.5 kcal/día
    assert.equal(p.weeks, 16);
    assert.equal(p.projectedWeightKg, 77);
    assert.deepEqual(p.warnings, []);
  });

  it('con peso objetivo: si el plazo exige un ritmo no permitido, se alarga y se avisa', () => {
    const gain = plan({ goal: 'gain', experience: 'intermediate', horizon: 'medium', targetWeightKg: 78 }); // +3 kg en 16 sem
    assert.equal(gain.limitedBy, 'tdee_window');
    assert.equal(gain.weeks, 16.7);
    assert.ok(gain.warnings.includes('HORIZON_EXTENDED'));

    const lose = plan({ goal: 'lose', experience: 'intermediate', horizon: 'short', targetWeightKg: 70 }); // −5 kg en 8 sem
    assert.equal(lose.limitedBy, 'tdee_window');
    assert.equal(lose.weeks, 8.4);
    assert.ok(lose.warnings.includes('HORIZON_EXTENDED'));
  });

  it('un ritmo más lento que la ventana se respeta (el mínimo es orientativo)', () => {
    const p = plan({ goal: 'gain', experience: 'intermediate', horizon: 'long', targetWeightKg: 75.5 });
    assert.equal(p.limitedBy, 'none');
    assert.equal(p.dailyDeltaKcal, 17);
    assert.equal(p.weeks, 32);
  });

  it('rechaza objetivos incoherentes con la meta y plazos absurdos', () => {
    const inconsistent = (e: unknown): boolean => e instanceof NutritionEngineError && e.code === 'INCONSISTENT_TARGET';
    assert.throws(() => plan({ goal: 'lose', experience: 'beginner', horizon: 'short', targetWeightKg: 80 }), inconsistent);
    assert.throws(() => plan({ goal: 'gain', experience: 'beginner', horizon: 'short', targetWeightKg: 70 }), inconsistent);
    assert.throws(() => plan({ goal: 'gain', experience: 'beginner', horizon: 'short', weeks: 0 }), outOfRange);
    assert.throws(() => plan({ goal: 'gain', experience: 'beginner', horizon: 'short', weeks: 105 }), outOfRange);
  });
});

// ───────────────────────────── Macros y fibra ─────────────────────────────

describe('macros', () => {
  it('volumen: 1.8 g/kg de proteína, grasa 25 %, carbohidratos = resto', () => {
    const m = computeMacros({ goal: 'gain', weightKg: 75, targetKcal: 2798, tdeeKcal: 2633.0625 });
    assert.equal(m.proteinG, 135);
    assert.equal(m.fatG, 78);
    assert.equal(m.carbsG, 389);
    assert.equal(m.kcal, 2798);
    assert.equal(m.fiberG, 39); // 14 g / 1000 kcal
    assert.equal(m.proteinBasis, 'total-bodyweight');
    assert.deepEqual(m.pctKcal, { protein: 0.19, carbs: 0.56, fat: 0.25 });
    assert.deepEqual(m.warnings, []);
  });

  it('déficit marcado con FFM conocida: 3.1 g/kg FFM; déficit leve: 2.3 g/kg FFM', () => {
    const marked = computeMacros({ goal: 'lose', weightKg: 80, ffmKg: 68, targetKcal: 2100, tdeeKcal: 2800 }); // −25 %
    assert.equal(marked.proteinG, 211); // 3.1 × 68 = 210.8
    assert.equal(marked.proteinBasis, 'fat-free-mass');
    assert.equal(marked.fatG, 64); // piso 0.8 g/kg (> 25 % de las kcal)
    assert.equal(marked.carbsG, 170);
    assert.equal(marked.kcal, 2100);

    const mild = computeMacros({ goal: 'lose', weightKg: 80, ffmKg: 68, targetKcal: 2380, tdeeKcal: 2800 }); // −15 %
    assert.equal(mild.proteinG, 156); // 2.3 × 68 = 156.4
  });

  it('nunca baja de 1.6 g/kg de peso total, aunque la FFM sea baja (% de grasa alto)', () => {
    const m = computeMacros({ goal: 'lose', weightKg: 100, ffmKg: 60, targetKcal: 2550, tdeeKcal: 3000 });
    assert.equal(m.proteinG, 160); // 2.3 × 60 = 138 < 160
  });

  it('déficit sin FFM: 2.2 g/kg de peso total; override del usuario con validación', () => {
    assert.equal(computeMacros({ goal: 'lose', weightKg: 80, targetKcal: 2200, tdeeKcal: 2800 }).proteinG, 176);
    const o = computeMacros({ goal: 'gain', weightKg: 80, targetKcal: 3000, tdeeKcal: 2800, proteinGPerKg: 2 });
    assert.equal(o.proteinG, 160);
    assert.equal(o.proteinBasis, 'user-override');
    assert.throws(() => computeMacros({ goal: 'gain', weightKg: 80, targetKcal: 3000, tdeeKcal: 2800, proteinGPerKg: 5 }), outOfRange);
  });

  it('grasa mínima por kg manda sobre el % cuando las kcal son pocas', () => {
    const m = computeMacros({ goal: 'maintain', weightKg: 90, targetKcal: 1500, tdeeKcal: 1500 });
    assert.equal(m.fatG, 72); // 0.8 × 90 > 0.25 × 1500 / 9
    assert.equal(m.carbsG, 51);
    assert.deepEqual(m.warnings, []);
  });

  it('presupuesto imposible: degrada grasa a 0.6 g/kg y proteína a ~1.6 g/kg, avisa y no da carbohidratos negativos', () => {
    const m = computeMacros({ goal: 'lose', weightKg: 110, targetKcal: 1300, tdeeKcal: 2000 });
    assert.deepEqual(m.warnings, ['MACRO_BUDGET_TIGHT']);
    assert.equal(m.fatG, 66); // 0.6 × 110
    assert.equal(m.proteinG, 177); // lo que alcanza tras la grasa mínima (≥ 1.6 g/kg = 176)
    assert.equal(m.carbsG, 0);
    assert.ok(m.kcal >= 1300 && m.kcal <= 1305, `kcal reales: ${m.kcal}`);
  });

  it('fibra: 14 g por 1000 kcal', () => {
    close(fiberTargetG(2000), 28);
    close(fiberTargetG(2800), 39.2);
    assert.throws(() => fiberTargetG(-5), outOfRange);
  });
});

// ───────────────────────────── Integración ─────────────────────────────

describe('buildNutritionPlan', () => {
  it('perfil con % de grasa + pasos + entrenamiento → plan completo coherente', () => {
    const plan = buildNutritionPlan({
      profile: { ...MALE, bodyFatPct: 15 },
      activity: { kind: 'steps', steps: 9000, exerciseKcal: 250 },
      goal: 'gain',
      experience: 'intermediate',
      horizon: 'medium',
    });
    assert.equal(plan.bmr.method, 'katch-mcardle');
    close(plan.bmr.kcal, 1747, 1e-6); // 370 + 21.6 × 63.75
    close(plan.tdee.kcal, 2509.80625, 1e-6); // 1747×1.2 + 6000×0.027234375 + 250
    assert.equal(plan.energy.targetKcal, 2667);
    assert.equal(plan.macros.proteinG, 135);
    assert.equal(plan.macros.fatG, 74);
    assert.equal(plan.macros.carbsG, 365);
    assert.equal(plan.macros.kcal, 2666);
    assert.deepEqual(plan.warnings, []);
  });
});

// ───────────────────── Barrido de invariantes (semilla fija) ─────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('invariantes sobre 3000 perfiles aleatorios', () => {
  it('nunca lanza, respeta pisos, topes y presupuesto de macros', () => {
    const rnd = mulberry32(20261106);
    const int = (min: number, max: number): number => min + Math.floor(rnd() * (max - min + 1));
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(rnd() * items.length)];
      if (item === undefined) throw new Error('lista vacía');
      return item;
    };
    const goals: readonly Goal[] = ['gain', 'lose', 'maintain'];
    const experiences: readonly Experience[] = ['beginner', 'intermediate', 'advanced'];
    const horizons: readonly Horizon[] = ['short', 'medium', 'long'];
    const seen = { floor: 0, window: 0, rate: 0, tight: 0 };

    for (let i = 0; i < 3000; i++) {
      const profile: BodyProfile = {
        sex: pick(['male', 'female'] as const),
        age: int(18, 75),
        heightCm: int(145, 205),
        weightKg: Math.round((45 + rnd() * 95) * 10) / 10,
        bodyFatPct: rnd() < 0.5 ? undefined : Math.round((8 + rnd() * 32) * 10) / 10,
      };
      const activity: ActivityModel =
        rnd() < 0.5
          ? { kind: 'pal', pal: Math.round((1.2 + rnd() * 0.7) * 100) / 100 }
          : { kind: 'steps', steps: int(0, 25_000), exerciseKcal: int(0, 800) };
      const req = { profile, activity, goal: pick(goals), experience: pick(experiences), horizon: pick(horizons) };
      const ctx = JSON.stringify(req);
      const plan = buildNutritionPlan(req);
      const { energy, macros, tdee } = plan;
      const w = profile.weightKg;

      assert.ok(energy.targetKcal >= 800, `target < 800: ${ctx}`);
      assert.ok(Number.isFinite(energy.weeks) && energy.weeks > 0, `weeks inválidas: ${ctx}`);
      if (req.goal === 'gain') {
        assert.ok(energy.dailyDeltaKcal > 0, `gain sin superávit: ${ctx}`);
        assert.ok(energy.pctOfTdee <= 0.1 + 0.006, `superávit > 10 %: ${ctx}`);
        assert.ok(energy.weeklyPctBodyWeight <= 0.5 + 0.006, `ganancia > 0.5 %/sem: ${ctx}`);
      } else if (req.goal === 'lose') {
        assert.ok(energy.dailyDeltaKcal <= 0, `lose con superávit: ${ctx}`);
        assert.ok(energy.pctOfTdee <= 0.25 + 0.006, `déficit > 25 %: ${ctx}`);
        assert.ok(energy.weeklyPctBodyWeight >= -1 - 0.006, `pérdida > 1 %/sem: ${ctx}`);
        const floor = Math.min(tdee.kcal, minKcalFloor(profile.sex, plan.bmr.kcal));
        assert.ok(energy.targetKcal >= Math.round(floor) - 1, `bajo el piso calórico: ${ctx}`);
      } else {
        assert.equal(energy.dailyDeltaKcal, 0, ctx);
      }

      assert.ok(macros.carbsG >= 0, `carbohidratos negativos: ${ctx}`);
      assert.ok(macros.fatG >= Math.round(0.6 * w) - 1, `grasa bajo 0.6 g/kg: ${ctx}`);
      assert.ok(macros.proteinG >= Math.round(1.6 * w) - 1, `proteína bajo 1.6 g/kg: ${ctx}`);
      assert.equal(macros.fiberG, Math.round((14 * energy.targetKcal) / 1000), ctx);
      if (!macros.warnings.includes('MACRO_BUDGET_TIGHT')) {
        assert.ok(Math.abs(macros.kcal - energy.targetKcal) <= 10, `kcal de macros ${macros.kcal} vs ${energy.targetKcal}: ${ctx}`);
      }

      if (energy.limitedBy === 'kcal_floor') seen.floor++;
      if (energy.limitedBy === 'tdee_window') seen.window++;
      if (energy.limitedBy === 'rate_cap') seen.rate++;
      if (macros.warnings.includes('MACRO_BUDGET_TIGHT')) seen.tight++;
    }
    // Información (no aserción): cuántos casos límite ejercitó el barrido.
    console.log(`    barrido: ${JSON.stringify(seen)}`);
  });
});
