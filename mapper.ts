import { normalizeBarcode } from './barcode';
import { isComplete, type FoodRecordInput, type Nutrients } from '../../domain/food';
import { OffError } from './errors';

type Json = Record<string, unknown>;

// Estos límites reflejan los CHECK de la tabla `foods`: lo que aquí se acepta, la base lo acepta.
const MAX_KCAL_100G = 950;
const MAX_SODIUM_MG_100G = 40_000;
const MAX_MACRO_SUM_G = 101; // proteína + carbohidratos + grasa por 100 g (1 g de tolerancia por redondeo)
const MAX_SERVING_G = 5000;
const KJ_PER_KCAL = 4.184;
const SALT_G_PER_SODIUM_G = 2.5;

export type OffDataWarningCode =
  | 'ENERGY_FROM_KJ' //        no venía kcal: se convirtió desde kJ
  | 'SODIUM_FROM_SALT' //      no venía sodio: se derivó de la sal (sodio = sal / 2.5)
  | 'VALUE_OUT_OF_RANGE' //    valor negativo o imposible: se descartó (queda null)
  | 'MACROS_EXCEED_100G' //    proteína + carbohidratos + grasa > 100 g por 100 g: dato dudoso
  | 'ENERGY_MISMATCH' //       kcal declaradas vs 4P + 4C + 9G difieren mucho (aviso; puede ser alcohol/polioles)
  | 'MISSING_NAME'; //         el producto no trae nombre: se usó "Producto <código>"

export interface OffDataWarning {
  code: OffDataWarningCode;
  field?: string | undefined;
}

export interface OffProduct {
  /** Código normalizado (clave estable para guardar en `foods.barcode`). */
  barcode: string;
  name: string;
  brand: string | null;
  /** Presentación tal como la escribe el fabricante, p. ej. "500 g". */
  quantityLabel: string | null;
  /** Porción de referencia en gramos (OFF `serving_quantity`), si existe. */
  servingG: number | null;
  servingLabel: string | null;
  /** Por 100 g (por 100 ml en líquidos; para la porción por gramaje se asume 1 ml ≈ 1 g). */
  nutrients: Nutrients;
  /** true si hay energía y los 3 macros y los datos son coherentes: se puede guardar sin pedir nada al usuario. */
  isComplete: boolean;
  warnings: OffDataWarning[];
}

export type OffLookupResult =
  | { status: 'found'; product: OffProduct }
  | { status: 'not_found'; barcode: string };

// ───────────────────────── Lectura defensiva de JSON ─────────────────────────

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** OFF suele mandar números, pero a veces strings ("12.5" o "12,5"). */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim().replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─────────────────────────────── Mapeo ───────────────────────────────

function mapNutrients(n: Json, warnings: OffDataWarning[]): Nutrients {
  const checked = (raw: unknown, max: number, field: string): number | null => {
    const value = num(raw);
    if (value === null) return null;
    if (value < 0 || value > max) {
      warnings.push({ code: 'VALUE_OUT_OF_RANGE', field });
      return null;
    }
    return round2(value);
  };

  // Energía: kcal directo; si falta, kJ / 4.184.
  let energyKcal: number | null;
  if (num(n['energy-kcal_100g']) !== null) {
    energyKcal = checked(n['energy-kcal_100g'], MAX_KCAL_100G, 'energyKcal');
  } else {
    const kj = num(n['energy_100g']);
    energyKcal = kj === null ? null : checked(kj / KJ_PER_KCAL, MAX_KCAL_100G, 'energyKcal');
    if (energyKcal !== null) warnings.push({ code: 'ENERGY_FROM_KJ' });
  }

  // Sodio en mg: `sodium_100g` viene en gramos; si falta, se deriva de la sal.
  const sodiumG = num(n['sodium_100g']);
  const saltG = num(n['salt_100g']);
  let sodiumMg: number | null = null;
  if (sodiumG !== null) {
    sodiumMg = checked(sodiumG * 1000, MAX_SODIUM_MG_100G, 'sodiumMg');
  } else if (saltG !== null) {
    sodiumMg = checked((saltG / SALT_G_PER_SODIUM_G) * 1000, MAX_SODIUM_MG_100G, 'sodiumMg');
    if (sodiumMg !== null) warnings.push({ code: 'SODIUM_FROM_SALT' });
  }

  return {
    energyKcal,
    proteinG: checked(n['proteins_100g'], 100, 'proteinG'),
    carbsG: checked(n['carbohydrates_100g'], 100, 'carbsG'),
    fatG: checked(n['fat_100g'], 100, 'fatG'),
    fiberG: checked(n['fiber_100g'], 100, 'fiberG'),
    sodiumMg,
  };
}

/** Convierte el objeto `product` crudo de OFF en un OffProduct tipado. Pura y sin excepciones. */
export function mapProduct(raw: Json, barcode: string, language: string): OffProduct {
  const warnings: OffDataWarning[] = [];
  const rawNutriments = raw['nutriments'];
  const nutrients = mapNutrients(isRecord(rawNutriments) ? rawNutriments : {}, warnings);

  const rawName = str(raw[`product_name_${language}`]) ?? str(raw['product_name']) ?? str(raw['generic_name']);
  if (rawName === null) warnings.push({ code: 'MISSING_NAME' });

  const macroSum = (nutrients.proteinG ?? 0) + (nutrients.carbsG ?? 0) + (nutrients.fatG ?? 0);
  const macrosOk = macroSum <= MAX_MACRO_SUM_G;
  if (!macrosOk) warnings.push({ code: 'MACROS_EXCEED_100G' });

  if (isComplete(nutrients)) {
    const atwater = 4 * nutrients.proteinG + 4 * nutrients.carbsG + 9 * nutrients.fatG;
    const diff = Math.abs(nutrients.energyKcal - atwater);
    if (diff > 30 && diff / Math.max(nutrients.energyKcal, atwater) > 0.3) {
      warnings.push({ code: 'ENERGY_MISMATCH' });
    }
  }

  const brand = str(raw['brands'])?.split(',')[0]?.trim() ?? null;
  const serving = num(raw['serving_quantity']);

  return {
    barcode,
    name: rawName ?? `Producto ${barcode}`,
    brand: brand === '' ? null : brand,
    quantityLabel: str(raw['quantity']),
    servingG: serving !== null && serving > 0 && serving <= MAX_SERVING_G ? round2(serving) : null,
    servingLabel: str(raw['serving_size']),
    nutrients,
    isComplete: isComplete(nutrients) && macrosOk,
    warnings,
  };
}

/**
 * Interpreta el cuerpo JSON de GET /api/v2/product/{code}.json.
 *  - `status: 0` (o sin `product`) → not_found.
 *  - Forma inesperada → OffError BAD_RESPONSE.
 */
export function parseProductResponse(json: unknown, barcode: string, language: string): OffLookupResult {
  if (!isRecord(json)) {
    throw new OffError('BAD_RESPONSE', 'La respuesta de Open Food Facts no es un objeto JSON.');
  }
  const status = json['status'];
  if (status === 0 || status === '0') return { status: 'not_found', barcode };

  const product = json['product'];
  if (!isRecord(product)) {
    if (status === 1 || status === '1') {
      throw new OffError('BAD_RESPONSE', 'La respuesta indica status=1 pero no trae "product".');
    }
    return { status: 'not_found', barcode };
  }
  return { status: 'found', product: mapProduct(product, barcode, language) };
}

/**
 * Producto de OFF → registro para la tabla `foods`. Devuelve null si está incompleto: en ese caso la UI
 * debe pedir al usuario los valores que faltan (creación manual rápida) antes de guardar.
 */
export function toFoodRecord(product: OffProduct, nowMs: number): FoodRecordInput | null {
  const n = product.nutrients;
  if (!product.isComplete || !isComplete(n)) return null;
  return {
    barcode: product.barcode,
    name: product.name,
    brand: product.brand,
    source: 'open_food_facts',
    kcal100g: n.energyKcal,
    protein100g: n.proteinG,
    carbs100g: n.carbsG,
    fat100g: n.fatG,
    fiber100g: n.fiberG,
    sodiumMg100g: n.sodiumMg,
    servingG: product.servingG,
    servingLabel: product.servingLabel,
    offFetchedAt: nowMs,
  };
}

/**
 * Interpreta el cuerpo de la búsqueda por texto (`{ products: [...] }`). Descarta ítems sin código GTIN válido.
 * Forma inesperada → OffError BAD_RESPONSE; lista vacía o ausente → [].
 */
export function parseSearchResponse(json: unknown, language: string): OffProduct[] {
  if (!isRecord(json)) throw new OffError('BAD_RESPONSE', 'La búsqueda de Open Food Facts no devolvió un objeto JSON.');
  const list = json['products'];
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new OffError('BAD_RESPONSE', 'La búsqueda trae "products" con forma inesperada.');
  const out: OffProduct[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const code = normalizeBarcode(String(item['code'] ?? ''));
    if (code === null) continue;
    out.push(mapProduct(item, code.code, language));
  }
  return out;
}
