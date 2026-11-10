import { OpenFoodFactsClient } from '../../../src/services/openFoodFacts';
import type { OffProduct } from '../../../src/services/openFoodFacts';
import { loadData, saveData, type AppData, type Food, type Recipe, type SlotId } from '../lib/model';
import { localDate } from '../lib/util';
import type { SamsungImport } from '../lib/samsung';

export type Prefill = Omit<Partial<Food>, 'per100'> & { per100?: { [K in keyof Food['per100']]?: Food['per100'][K] | undefined } };
export type Mode = 'search' | 'scan' | 'mine' | 'manual';
export interface RecipeDraft {
  id: string | null;
  name: string;
  servings: number;
  ings: { foodId: string; name: string; grams: number }[];
}
export type Sheet =
  | { kind: 'add'; slot: SlotId; mode: Mode; status: string; results: OffProduct[]; query: string; scanning: boolean }
  | { kind: 'portion'; food: Food; slot: SlotId; entryId: string | null; grams: number; date: string }
  | { kind: 'manual'; slot: SlotId | null; editId: string | null; prefill: Prefill; notice: string | null }
  | { kind: 'recipe'; draft: RecipeDraft }
  | { kind: 'activity'; date: string };

export const S = {
  data: loadData() as AppData,
  tab: 'hoy' as 'hoy' | 'alimentos' | 'progreso' | 'plan',
  date: localDate(),
  sheet: null as Sheet | null,
  toastMsg: '',
  range: 90,
  imp: null as SamsungImport | null,
  diag: [] as string[],
};

/** Cliente de Open Food Facts para navegador: sin User-Agent (no se puede fijar) → solo cabeceras simples, sin preflight. */
export const off = new OpenFoodFactsClient({ appName: '', appVersion: '', contact: '', sendUserAgent: false, language: 'es' });

export const hooks = { render: () => {}, renderSheet: () => {} };

export function commit(): void {
  if (!saveData(S.data)) toast('No se pudo guardar en este navegador. Exporta un respaldo.');
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string): void {
  S.toastMsg = msg;
  const el = document.getElementById('toast');
  if (el) {
    el.textContent = msg;
    el.hidden = false;
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    const e = document.getElementById('toast');
    if (e) e.hidden = true;
  }, 3200);
}

export function recipeOfFood(foodId: string): Recipe | undefined {
  return Object.values(S.data.recipes).find((r) => r.foodId === foodId);
}
