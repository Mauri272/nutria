/** Tipos y matemática pura de alimentos (por 100 g ⇄ por porción). Sin I/O ni dependencias. */

/** Nutrientes. `null` = dato desconocido (distinto de 0). Se usa por 100 g y por porción. */
export interface Nutrients {
  energyKcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  sodiumMg: number | null;
}

export type NutrientsPer100g = Nutrients;
export type PortionNutrients = Nutrients;

/** Un alimento se puede guardar/registrar solo si conocemos energía y los tres macros. */
export interface CompleteNutrientsPer100g extends Nutrients {
  energyKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export function isComplete(n: Nutrients): n is CompleteNutrientsPer100g {
  return n.energyKcal !== null && n.proteinG !== null && n.carbsG !== null && n.fatG !== null;
}

/**
 * Selector de porción por gramaje: recalcula en tiempo real (valor por 100 g × gramos / 100, a 1 decimal).
 * Los datos desconocidos (null) siguen siendo null; la UI los muestra como "—".
 */
export function scaleNutrients(per100g: Nutrients, grams: number): PortionNutrients {
  if (!Number.isFinite(grams) || grams < 0) {
    throw new RangeError(`grams debe ser un número ≥ 0 (recibido: ${grams}).`);
  }
  const k = grams / 100;
  const scale = (v: number | null): number | null => (v === null ? null : Math.round(v * k * 10) / 10);
  return {
    energyKcal: scale(per100g.energyKcal),
    proteinG: scale(per100g.proteinG),
    carbsG: scale(per100g.carbsG),
    fatG: scale(per100g.fatG),
    fiberG: scale(per100g.fiberG),
    sodiumMg: scale(per100g.sodiumMg),
  };
}

/**
 * Forma común (alimento de Open Food Facts o creado a mano) lista para insertarse en la tabla `foods`.
 * Mapeo a columnas: kcal100g→kcal_100g, protein100g→protein_100g, sodiumMg100g→sodium_mg_100g, etc.
 */
export interface FoodRecordInput {
  barcode: string | null;
  name: string;
  brand: string | null;
  source: 'open_food_facts' | 'user';
  kcal100g: number;
  protein100g: number;
  carbs100g: number;
  fat100g: number;
  fiber100g: number | null;
  sodiumMg100g: number | null;
  servingG: number | null;
  servingLabel: string | null;
  /** Epoch ms de la consulta a Open Food Facts; null si lo creó el usuario. */
  offFetchedAt: number | null;
}
