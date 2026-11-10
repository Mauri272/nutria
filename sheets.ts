import { OffError, type OffProduct } from '../../../src/services/openFoodFacts';
import { portion, recipeNutrition, SLOTS, type Food, type Per100, type SlotId } from '../lib/model';
import { cameraSupported, scanImageFile, scannerSupported, startLiveScan, type LiveScan } from '../lib/scanner';
import { esc, fmt, parseNum, uid } from '../lib/util';
import { commit, hooks, off, recipeOfFood, S, toast, type Prefill, type RecipeDraft } from './state';
import { currentTarget } from './views';

const slotLabel = (id: SlotId): string => SLOTS.find((s) => s.id === id)?.label ?? id;
let live: LiveScan | null = null;

export function stopLive(): void {
  live?.stop();
  live = null;
}

function offFood(p: OffProduct): Food {
  const n = p.nutrients;
  return {
    id: `off:${p.barcode}`, name: p.name, brand: p.brand, barcode: p.barcode, source: 'off', servingG: p.servingG, createdAt: Date.now(),
    per100: { kcal: n.energyKcal ?? 0, protein: n.proteinG ?? 0, carbs: n.carbsG ?? 0, fat: n.fatG ?? 0, fiber: n.fiberG, sodium: n.sodiumMg },
  };
}

function offMsg(e: unknown): string {
  if (e instanceof OffError) {
    if (e.code === 'NETWORK' || e.code === 'TIMEOUT') return 'No se pudo conectar con Open Food Facts. Revisa tu conexión (o crea el alimento a mano).';
    if (e.code === 'RATE_LIMITED') return 'Open Food Facts pide esperar un momento (límite de consultas). Intenta en un minuto.';
    if (e.code === 'INVALID_BARCODE') return 'Código inválido: revisa los dígitos (EAN-13, EAN-8 o UPC-A).';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function openAdd(slot: SlotId): void {
  S.sheet = { kind: 'add', slot, mode: 'search', status: '', results: [], query: '', scanning: false };
  hooks.renderSheet();
}
export function closeSheet(): void {
  stopLive();
  S.sheet = null;
  hooks.renderSheet();
}

function foodRow(f: Food): string {
  return `<button class="row" data-act="pick-food" data-id="${esc(f.id)}"><span class="row-main"><b>${esc(f.name)}</b><small>${esc(f.brand ?? (f.source === 'recipe' ? 'Receta' : f.source === 'off' ? 'Open Food Facts' : 'Manual'))}</small></span><span class="row-v">${fmt(f.per100.kcal)} kcal/100 g</span></button>`;
}
function localMatches(q: string): Food[] {
  const t = q.trim().toLowerCase();
  return Object.values(S.data.foods).filter((f) => !t || `${f.name} ${f.brand ?? ''} ${f.barcode ?? ''}`.toLowerCase().includes(t)).sort((a, b) => a.name.localeCompare(b.name, 'es')).slice(0, 40);
}

function addHtml(): string {
  const s = S.sheet;
  if (s?.kind !== 'add') return '';
  const tabs: [string, string][] = [['search', 'Buscar'], ['scan', 'Escanear'], ['mine', 'Mis alimentos'], ['manual', 'Manual']];
  let body = '';
  if (s.mode === 'search') {
    const mine = s.query ? localMatches(s.query) : [];
    body = `<form data-form="search" class="inline-form"><label class="field grow"><span>Nombre del producto</span><input id="q" type="search" value="${esc(s.query)}" autocomplete="off" enterkeyhint="search"></label><button class="btn primary" type="submit">Buscar</button></form>
      <p class="muted small" id="status">${esc(s.status)}</p>
      ${mine.length ? `<h3>Guardados</h3>${mine.map(foodRow).join('')}` : ''}
      ${s.results.length ? `<h3>Open Food Facts</h3>${s.results.map((p, i) => `<button class="row" data-act="pick-off" data-i="${i}"><span class="row-main"><b>${esc(p.name)}</b><small>${esc(p.brand ?? '')}${p.isComplete ? '' : ' · datos incompletos'}</small></span><span class="row-v">${p.nutrients.energyKcal === null ? '—' : `${fmt(p.nutrients.energyKcal)} kcal/100 g`}</span></button>`).join('')}` : ''}`;
  } else if (s.mode === 'scan') {
    body = `${cameraSupported() ? `<button class="btn primary" data-act="cam-start">Escanear con la cámara</button>` : ''}
      <div id="camwrap" ${s.scanning ? '' : 'hidden'}><video id="cam" muted playsinline></video><button class="btn ghost" data-act="cam-stop">Detener cámara</button></div>
      ${scannerSupported() ? `<label class="btn ghost filebtn">Leer desde una foto<input id="photo" type="file" accept="image/*" capture="environment" hidden></label>` : '<p class="muted small">Este navegador no lee códigos de barras. Escribe el número.</p>'}
      <form data-form="code" class="inline-form"><label class="field grow"><span>Código de barras</span><input id="code" inputmode="numeric" autocomplete="off" placeholder="7801234567890"></label><button class="btn primary" type="submit">Buscar</button></form>
      <p class="muted small" id="status">${esc(s.status)}</p>`;
  } else if (s.mode === 'mine') {
    body = `<label class="field"><span>Filtrar</span><input id="mf" type="search" autocomplete="off"></label><div id="minelist">${localMatches('').map(foodRow).join('') || '<p class="muted small">Aún no tienes alimentos guardados.</p>'}</div>`;
  } else {
    body = manualFormHtml({ slot: s.slot, editId: null, prefill: {}, notice: null });
  }
  return `<div class="sheet-h"><h2>Agregar a ${slotLabel(s.slot)}</h2><button class="link" data-act="close">Cerrar</button></div><div class="seg wide">${tabs.map(([m, l]) => `<button class="${s.mode === m ? 'on' : ''}" data-act="mode" data-m="${m}">${l}</button>`).join('')}</div><div class="sheet-b">${body}</div>`;
}

function portionHtml(): string {
  const s = S.sheet;
  if (s?.kind !== 'portion') return '';
  const f = s.food;
  const chips = [...new Set([50, 100, 150, 200, ...(f.servingG ? [f.servingG] : [])])].sort((a, b) => a - b);
  return `<div class="sheet-h"><h2>${esc(f.name)}</h2><button class="link" data-act="close">Cerrar</button></div><div class="sheet-b">
    <p class="muted small">${esc(f.brand ?? '')} ${f.barcode ? `· ${esc(f.barcode)}` : ''}${f.servingG ? ` · porción ${fmt(f.servingG)} g` : ''}</p>
    <label class="field"><span>Cantidad (g)</span><input id="g" inputmode="decimal" value="${s.grams}" autocomplete="off"></label>
    <div class="chips">${chips.map((c) => `<button class="chip" data-act="grams" data-g="${c}">${fmt(c)} g</button>`).join('')}</div>
    <div id="pv" class="pv">${pvHtml(f.per100, s.grams)}</div>
    <button class="btn primary" data-act="portion-save">${s.entryId ? 'Guardar cambios' : `Agregar a ${slotLabel(s.slot)}`}</button>
    ${s.entryId ? '<button class="btn danger" data-act="entry-del">Eliminar del diario</button>' : ''}
    ${!s.entryId && f.source !== 'off' ? '' : ''}</div>`;
}
export function pvHtml(p100: Per100, grams: number): string {
  const p = portion(p100, Math.max(0, grams));
  return `<div class="pv-k"><b>${fmt(p.kcal)}</b> kcal</div><div class="pv-m"><span><i class="dot c-protein"></i>P ${fmt(p.protein, 1)} g</span><span><i class="dot c-carbs"></i>C ${fmt(p.carbs, 1)} g</span><span><i class="dot c-fat"></i>G ${fmt(p.fat, 1)} g</span><span><i class="dot c-fiber"></i>Fibra ${fmt(p.fiber, 1)} g</span></div>`;
}
export function updatePortionPreview(): void {
  const s = S.sheet;
  if (s?.kind !== 'portion') return;
  const g = parseNum((document.getElementById('g') as HTMLInputElement | null)?.value) ?? 0;
  s.grams = g;
  const pv = document.getElementById('pv');
  if (pv) pv.innerHTML = pvHtml(s.food.per100, g);
}

function manualFormHtml(o: { slot: SlotId | null; editId: string | null; prefill: Prefill; notice: string | null }): string {
  const p = o.prefill;
  const v = (x: unknown) => (x === null || x === undefined ? '' : esc(x));
  const per = p.per100 ?? {};
  return `${o.notice ? `<p class="warn">${esc(o.notice)}</p>` : ''}<form id="mf-form" data-form="manual" class="grid2" autocomplete="off">
    <label class="field span2"><span>Nombre</span><input id="f-name" value="${v(p.name)}" required></label>
    <label class="field"><span>Marca (opcional)</span><input id="f-brand" value="${v(p.brand)}"></label>
    <label class="field"><span>Código (opcional)</span><input id="f-bc" inputmode="numeric" value="${v(p.barcode)}"></label>
    <label class="field"><span>kcal / 100 g</span><input id="f-kcal" inputmode="decimal" value="${v(per.kcal)}"></label>
    <label class="field"><span>Proteína g</span><input id="f-p" inputmode="decimal" value="${v(per.protein)}"></label>
    <label class="field"><span>Carbohidratos g</span><input id="f-c" inputmode="decimal" value="${v(per.carbs)}"></label>
    <label class="field"><span>Grasas g</span><input id="f-f" inputmode="decimal" value="${v(per.fat)}"></label>
    <label class="field"><span>Fibra g (opcional)</span><input id="f-fi" inputmode="decimal" value="${v(per.fiber)}"></label>
    <label class="field"><span>Sodio mg (opcional)</span><input id="f-na" inputmode="decimal" value="${v(per.sodium)}"></label>
    <label class="field span2"><span>Porción habitual en g (opcional)</span><input id="f-sv" inputmode="decimal" value="${v(p.servingG)}"></label>
    <p class="err span2" id="f-err" hidden></p>
    <button class="btn primary span2" type="submit">${o.editId ? 'Guardar' : o.slot ? 'Guardar y elegir cantidad' : 'Guardar alimento'}</button>
    ${o.editId ? '<button class="btn danger span2" type="button" data-act="food-del">Eliminar alimento</button>' : ''}</form>`;
}

function manualSheetHtml(): string {
  const s = S.sheet;
  if (s?.kind !== 'manual') return '';
  return `<div class="sheet-h"><h2>${s.editId ? 'Editar alimento' : 'Nuevo alimento'}</h2><button class="link" data-act="close">Cerrar</button></div><div class="sheet-b">${manualFormHtml(s)}</div>`;
}

export function recipeTotalsHtml(d: RecipeDraft): string {
  const r = recipeNutrition(d.ings, S.data.foods, d.servings);
  return `<div class="stats"><div><b>${fmt(r.total.kcal)}</b><span class="muted small">kcal totales · ${fmt(r.grams)} g</span></div><div><b>${fmt(r.per100.kcal)}</b><span class="muted small">kcal / 100 g</span></div><div><b>${fmt(r.perServing.kcal)}</b><span class="muted small">kcal / porción (${fmt(r.perServing.grams)} g)</span></div></div>
  <p class="muted small">Por porción: P ${fmt(r.perServing.protein, 1)} g · C ${fmt(r.perServing.carbs, 1)} g · G ${fmt(r.perServing.fat, 1)} g. Por 100 g: P ${fmt(r.per100.protein, 1)} · C ${fmt(r.per100.carbs, 1)} · G ${fmt(r.per100.fat, 1)}.</p>`;
}
function recipeHtml(): string {
  const s = S.sheet;
  if (s?.kind !== 'recipe') return '';
  const d = s.draft;
  const pool = Object.values(S.data.foods).filter((f) => f.id !== (d.id ? S.data.recipes[d.id]?.foodId : '')).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return `<div class="sheet-h"><h2>${d.id ? 'Editar receta' : 'Nueva receta'}</h2><button class="link" data-act="close">Cerrar</button></div><div class="sheet-b">
    <div class="grid2"><label class="field"><span>Nombre</span><input id="r-name" value="${esc(d.name)}" autocomplete="off"></label><label class="field"><span>Porciones</span><input id="r-serv" inputmode="numeric" value="${d.servings}"></label></div>
    <h3>Ingredientes (gramos)</h3>
    ${d.ings.map((i, k) => `<div class="ing"><span class="grow">${esc(i.name)}</span><input class="ig" id="ig-${k}" data-k="${k}" inputmode="decimal" value="${i.grams}" aria-label="Gramos de ${esc(i.name)}"><button class="icon-btn" data-act="ing-del" data-k="${k}" aria-label="Quitar">×</button></div>`).join('') || '<p class="muted small">Agrega ingredientes desde tus alimentos guardados.</p>'}
    <div id="rtot">${recipeTotalsHtml(d)}</div>
    <h3>Agregar ingrediente</h3><label class="field"><span>Filtrar mis alimentos</span><input id="rq" type="search" autocomplete="off"></label>
    <div id="rlist">${pool.slice(0, 30).map((f) => `<button class="row" data-act="ing-add" data-id="${esc(f.id)}"><span class="row-main"><b>${esc(f.name)}</b><small>${esc(f.brand ?? '')}</small></span><span class="row-v">${fmt(f.per100.kcal)} kcal/100 g</span></button>`).join('') || '<p class="muted small">Primero guarda alimentos (escanéalos o créalos).</p>'}</div>
    <p class="err" id="r-err" hidden></p>
    <button class="btn primary" data-act="recipe-save">Guardar receta</button>${d.id ? '<button class="btn danger" data-act="recipe-del">Eliminar receta</button>' : ''}</div>`;
}
export function recipePoolHtml(q: string): string {
  const t = q.trim().toLowerCase();
  return Object.values(S.data.foods).filter((f) => !t || `${f.name} ${f.brand ?? ''}`.toLowerCase().includes(t)).slice(0, 30)
    .map((f) => `<button class="row" data-act="ing-add" data-id="${esc(f.id)}"><span class="row-main"><b>${esc(f.name)}</b><small>${esc(f.brand ?? '')}</small></span><span class="row-v">${fmt(f.per100.kcal)} kcal/100 g</span></button>`).join('');
}

function activityHtml(): string {
  const s = S.sheet;
  if (s?.kind !== 'activity') return '';
  const day = S.data.days[s.date];
  const m = day?.sleepMin;
  return `<div class="sheet-h"><h2>Pasos y sueño</h2><button class="link" data-act="close">Cerrar</button></div><div class="sheet-b"><form data-form="activity" class="grid2">
    <label class="field span2"><span>Pasos del día</span><input id="a-steps" inputmode="numeric" value="${day?.steps ?? ''}"></label>
    <label class="field"><span>Sueño (horas)</span><input id="a-sh" inputmode="numeric" value="${m !== undefined ? Math.floor(m / 60) : ''}"></label>
    <label class="field"><span>Minutos</span><input id="a-sm" inputmode="numeric" value="${m !== undefined ? m % 60 : ''}"></label>
    <button class="btn primary span2" type="submit">Guardar</button></form><p class="muted small">Para cargar muchos días de una vez, importa tu exportación de Samsung Health en la pestaña Plan.</p></div>`;
}

export function sheetHtml(): string {
  const s = S.sheet;
  if (!s) return '';
  return s.kind === 'add' ? addHtml() : s.kind === 'portion' ? portionHtml() : s.kind === 'manual' ? manualSheetHtml() : s.kind === 'recipe' ? recipeHtml() : activityHtml();
}

/** Tras pintar la hoja: arranca la cámara si corresponde. */
export async function afterSheetRender(): Promise<void> {
  const s = S.sheet;
  if (s?.kind === 'add' && s.mode === 'scan' && s.scanning && !live) {
    const video = document.getElementById('cam') as HTMLVideoElement | null;
    if (!video) return;
    try {
      live = await startLiveScan(video, (code) => { live = null; if (S.sheet?.kind === 'add') S.sheet.scanning = false; void lookupBarcode(code); }, (msg) => setStatus(msg));
    } catch (e) {
      live = null;
      s.scanning = false;
      s.status = e instanceof Error && /Permission|NotAllowed/i.test(e.name + e.message) ? 'La cámara está bloqueada. Permítela en el candado de la barra de direcciones, o usa la foto / escribe el número.' : e instanceof Error ? e.message : String(e);
      hooks.renderSheet();
    }
  }
}

function setStatus(msg: string): void {
  if (S.sheet?.kind === 'add') S.sheet.status = msg;
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

export async function runSearch(q: string): Promise<void> {
  const s = S.sheet;
  if (s?.kind !== 'add') return;
  s.query = q;
  s.results = [];
  if (q.trim().length < 2) { s.status = 'Escribe al menos 2 letras.'; hooks.renderSheet(); return; }
  s.status = 'Buscando en Open Food Facts…';
  hooks.renderSheet();
  try {
    const res = await off.searchProducts(q);
    if (S.sheet !== s) return;
    s.results = res;
    s.status = res.length ? `${res.length} resultados` : 'Open Food Facts no encontró coincidencias. Prueba otro nombre, escanea el código o crea el alimento a mano.';
  } catch (e) {
    if (S.sheet !== s) return;
    s.status = offMsg(e);
  }
  hooks.renderSheet();
}

export async function lookupBarcode(raw: string): Promise<void> {
  const s = S.sheet;
  if (s?.kind !== 'add') return;
  s.mode = 'scan';
  const digits = raw.replace(/[\s-]/g, '');
  const local = Object.values(S.data.foods).find((f) => f.barcode === digits || (digits.length === 12 && f.barcode === `0${digits}`));
  if (local) { openPortion(local, s.slot); return; }
  s.status = 'Buscando en Open Food Facts…';
  hooks.renderSheet();
  try {
    const r = await off.getProductByBarcode(raw);
    if (S.sheet !== s) return;
    if (r.status === 'not_found') {
      openManual(s.slot, { barcode: r.barcode }, 'Ese código no está en Open Food Facts. Ingresa los valores de la etiqueta (por 100 g): quedará guardado para la próxima vez.');
    } else if (r.product.isComplete) {
      openPortion(offFood(r.product), s.slot);
    } else {
      const f = offFood(r.product);
      openManual(s.slot, { ...f, per100: { kcal: r.product.nutrients.energyKcal ?? undefined, protein: r.product.nutrients.proteinG ?? undefined, carbs: r.product.nutrients.carbsG ?? undefined, fat: r.product.nutrients.fatG ?? undefined, fiber: r.product.nutrients.fiberG, sodium: r.product.nutrients.sodiumMg } }, 'Open Food Facts no trae todos los datos de este producto. Completa los que faltan.');
    }
  } catch (e) {
    if (S.sheet !== s) return;
    s.status = offMsg(e);
    hooks.renderSheet();
  }
}

export function pickOff(i: number): void {
  const s = S.sheet;
  if (s?.kind !== 'add') return;
  const p = s.results[i];
  if (!p) return;
  if (p.isComplete) openPortion(offFood(p), s.slot);
  else {
    const f = offFood(p);
    openManual(s.slot, { ...f, per100: { kcal: p.nutrients.energyKcal ?? undefined, protein: p.nutrients.proteinG ?? undefined, carbs: p.nutrients.carbsG ?? undefined, fat: p.nutrients.fatG ?? undefined, fiber: p.nutrients.fiberG, sodium: p.nutrients.sodiumMg } }, 'Faltan datos de este producto. Complétalos desde la etiqueta.');
  }
}

export function openPortion(food: Food, slot: SlotId, entryId: string | null = null, grams?: number): void {
  stopLive();
  S.sheet = { kind: 'portion', food, slot, entryId, grams: grams ?? food.servingG ?? 100, date: S.date };
  hooks.renderSheet();
}
export function openManual(slot: SlotId | null, prefill: Prefill = {}, notice: string | null = null, editId: string | null = null): void {
  stopLive();
  S.sheet = { kind: 'manual', slot, editId, prefill, notice };
  hooks.renderSheet();
}

export function savePortion(): void {
  const s = S.sheet;
  if (s?.kind !== 'portion') return;
  const g = parseNum((document.getElementById('g') as HTMLInputElement | null)?.value);
  if (g === null || g <= 0 || g > 5000) { toast('Ingresa una cantidad entre 1 y 5000 g.'); return; }
  const f = s.food;
  if (!S.data.foods[f.id]) S.data.foods[f.id] = f; // guarda en "Mis alimentos" (caché local de OFF / manual)
  const day = (S.data.days[s.date] ??= { entries: [] });
  const p = portion(f.per100, g);
  if (s.entryId) {
    const e = day.entries.find((x) => x.id === s.entryId);
    if (e) Object.assign(e, { grams: g, ...p });
  } else {
    day.entries.push({ id: uid(), slot: s.slot, name: f.name, grams: g, ...p, foodId: f.id, ts: Date.now() });
  }
  const t = currentTarget().target;
  if (!day.target && t) day.target = t; // se congela el objetivo del día
  commit();
  toast(s.entryId ? 'Cambios guardados' : `Agregado a ${slotLabel(s.slot)}`);
  closeSheet();
  hooks.render();
}

export function deleteEntry(): void {
  const s = S.sheet;
  if (s?.kind !== 'portion' || !s.entryId) return;
  const day = S.data.days[s.date];
  if (day) day.entries = day.entries.filter((e) => e.id !== s.entryId);
  commit();
  closeSheet();
  hooks.render();
}

export function saveManual(): void {
  const raw = S.sheet;
  // El formulario vive en la pestaña "Manual" de la hoja de agregar o en su propia hoja (editar / código no encontrado).
  const s = raw?.kind === 'manual' ? raw : raw?.kind === 'add' ? { kind: 'manual' as const, slot: raw.slot, editId: null } : null;
  if (!s) return;
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
  const err = (m: string) => { const e = document.getElementById('f-err'); if (e) { e.textContent = m; e.hidden = false; } };
  const name = val('f-name').trim();
  const kcal = parseNum(val('f-kcal')), pr = parseNum(val('f-p')), ch = parseNum(val('f-c')), fa = parseNum(val('f-f'));
  const fi = parseNum(val('f-fi')), na = parseNum(val('f-na')), sv = parseNum(val('f-sv'));
  const bc = val('f-bc').replace(/[\s-]/g, '');
  if (!name) return err('Escribe un nombre.');
  if (kcal === null || pr === null || ch === null || fa === null) return err('Completa kcal, proteína, carbohidratos y grasas (por 100 g). Usa 0 si no tiene.');
  if (kcal < 0 || kcal > 950) return err('Las kcal por 100 g deben estar entre 0 y 950.');
  if ([pr, ch, fa].some((x) => x < 0 || x > 100) || pr + ch + fa > 101) return err('Los macros por 100 g no pueden sumar más de 100 g.');
  if ((fi !== null && (fi < 0 || fi > 100)) || (na !== null && (na < 0 || na > 40000)) || (sv !== null && (sv <= 0 || sv > 5000))) return err('Revisa fibra, sodio o porción: hay un valor fuera de rango.');
  const existing = s.editId ? S.data.foods[s.editId] : bc ? Object.values(S.data.foods).find((f) => f.barcode === bc) : undefined;
  const food: Food = {
    id: existing?.id ?? (bc ? `bc:${bc}` : uid()), name, brand: val('f-brand').trim() || null, barcode: bc || null,
    source: existing?.source ?? 'user', servingG: sv, createdAt: existing?.createdAt ?? Date.now(),
    per100: { kcal, protein: pr, carbs: ch, fat: fa, fiber: fi, sodium: na },
  };
  S.data.foods[food.id] = food;
  commit();
  if (s.slot) openPortion(food, s.slot);
  else { closeSheet(); toast('Alimento guardado'); hooks.render(); }
}

export function deleteFood(): void {
  const s = S.sheet;
  if (s?.kind !== 'manual' || !s.editId) return;
  delete S.data.foods[s.editId];
  commit();
  closeSheet();
  toast('Alimento eliminado (el diario conserva sus registros)');
  hooks.render();
}

// ── Recetas ──
export function openRecipe(id: string | null): void {
  const r = id ? S.data.recipes[id] : undefined;
  S.sheet = { kind: 'recipe', draft: { id, name: r?.name ?? '', servings: r?.servings ?? 1, ings: r ? r.ingredients.map((i) => ({ ...i })) : [] } };
  hooks.renderSheet();
}
export function syncDraft(): void {
  const s = S.sheet;
  if (s?.kind !== 'recipe') return;
  const d = s.draft;
  d.name = (document.getElementById('r-name') as HTMLInputElement | null)?.value ?? d.name;
  d.servings = Math.max(1, Math.round(parseNum((document.getElementById('r-serv') as HTMLInputElement | null)?.value) ?? 1));
  d.ings.forEach((i, k) => { i.grams = parseNum((document.getElementById(`ig-${k}`) as HTMLInputElement | null)?.value) ?? 0; });
}
export function addIngredient(foodId: string): void {
  const s = S.sheet;
  const f = S.data.foods[foodId];
  if (s?.kind !== 'recipe' || !f) return;
  syncDraft();
  s.draft.ings.push({ foodId, name: f.name, grams: f.servingG ?? 100 });
  hooks.renderSheet();
}
export function delIngredient(k: number): void {
  const s = S.sheet;
  if (s?.kind !== 'recipe') return;
  syncDraft();
  s.draft.ings.splice(k, 1);
  hooks.renderSheet();
}
export function saveRecipe(): void {
  const s = S.sheet;
  if (s?.kind !== 'recipe') return;
  syncDraft();
  const d = s.draft;
  const err = (m: string) => { const e = document.getElementById('r-err'); if (e) { e.textContent = m; e.hidden = false; } };
  if (!d.name.trim()) return err('Ponle un nombre a la receta.');
  const ings = d.ings.filter((i) => i.grams > 0);
  if (!ings.length) return err('Agrega al menos un ingrediente con gramos.');
  const n = recipeNutrition(ings, S.data.foods, d.servings);
  const id = d.id ?? uid();
  const prev = S.data.recipes[id];
  const foodId = prev?.foodId ?? `rcp:${id}`;
  S.data.recipes[id] = { id, foodId, name: d.name.trim(), servings: d.servings, ingredients: ings };
  S.data.foods[foodId] = { id: foodId, name: d.name.trim(), brand: null, barcode: null, source: 'recipe', per100: n.per100, servingG: n.perServing.grams || null, createdAt: S.data.foods[foodId]?.createdAt ?? Date.now() };
  commit();
  closeSheet();
  toast('Receta guardada');
  hooks.render();
}
export function deleteRecipe(): void {
  const s = S.sheet;
  if (s?.kind !== 'recipe' || !s.draft.id) return;
  const r = S.data.recipes[s.draft.id];
  if (r) { delete S.data.foods[r.foodId]; delete S.data.recipes[r.id]; }
  commit();
  closeSheet();
  hooks.render();
}

export function openFoodEdit(id: string): void {
  const f = S.data.foods[id];
  if (!f) return;
  const r = recipeOfFood(id);
  if (r) { openRecipe(r.id); return; }
  openManual(null, f, null, id);
}

export async function scanPhoto(file: File): Promise<void> {
  setStatus('Leyendo la foto…');
  try {
    const code = await scanImageFile(file);
    if (code) await lookupBarcode(code);
    else setStatus('No se encontró un código válido en la foto. Acércate, enfoca y reintenta, o escribe el número.');
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

export function saveActivity(): void {
  const s = S.sheet;
  if (s?.kind !== 'activity') return;
  const steps = parseNum((document.getElementById('a-steps') as HTMLInputElement).value);
  const h = parseNum((document.getElementById('a-sh') as HTMLInputElement).value);
  const m = parseNum((document.getElementById('a-sm') as HTMLInputElement).value);
  const day = (S.data.days[s.date] ??= { entries: [] });
  if (steps !== null && steps >= 0 && steps <= 100000) day.steps = Math.round(steps);
  if (h !== null || m !== null) {
    const min = Math.round((h ?? 0) * 60 + (m ?? 0));
    if (min > 0 && min <= 1440) { day.sleepMin = min; delete day.sleepStages; }
  }
  commit();
  closeSheet();
  hooks.render();
}
