import { importSamsung, type CsvFile } from './lib/samsung';
import { readZipTexts } from './lib/zip';
import type { Experience, Goal, Horizon, Sex } from '../../src/domain/nutritionEngine';
import { computePlan, migrate, MEASURE_KEYS, type MeasureKey, type Profile, type SlotId } from './lib/model';
import { addDays, localDate, parseNum } from './lib/util';
import { cameraSupported, scannerSupported } from './lib/scanner';
import { commit, hooks, off, recipeOfFood, S, toast } from './ui/state';
import * as sh from './ui/sheets';
import { currentTarget, impHtml, planResultHtml, viewAlimentos, viewHoy, viewPlan, viewProgreso } from './ui/views';
import { saveData } from './lib/model';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';

function render(): void {
  const view = S.tab === 'hoy' ? viewHoy() : S.tab === 'alimentos' ? viewAlimentos() : S.tab === 'progreso' ? viewProgreso() : viewPlan();
  $('main').innerHTML = view;
  document.querySelectorAll<HTMLElement>('#tabs [data-t]').forEach((b) => b.classList.toggle('on', b.dataset['t'] === S.tab));
  if (S.tab === 'plan') updatePlanLive();
}
function renderSheet(): void {
  const el = $('sheet');
  const html = sh.sheetHtml();
  el.hidden = html === '';
  el.innerHTML = html;
  document.body.classList.toggle('noscroll', html !== '');
  void sh.afterSheetRender();
}
hooks.render = render;
hooks.renderSheet = renderSheet;

// ── Plan (formulario → motor) ──
function readProfile(): Profile | null {
  const age = parseNum(val('p-age')), h = parseNum(val('p-h')), w = parseNum(val('p-w'));
  if (age === null || h === null || w === null) return null;
  const bf = parseNum(val('p-bf')), tw = parseNum(val('p-tw'));
  return { sex: val('p-sex') as Sex, age, heightCm: h, weightKg: w, bodyFatPct: bf, experience: val('p-exp') as Experience, goal: val('p-goal') as Goal, horizon: val('p-hor') as Horizon, targetWeightKg: tw, activity: val('p-act') as 'pal' | 'steps', pal: Number(val('p-pal')) };
}
function planFromForm() {
  const p = readProfile();
  if (!p) return null;
  const today = localDate();
  const data = { ...S.data, profile: p, weights: { ...S.data.weights, [today]: p.weightKg } };
  return { p, r: computePlan(data, today) };
}
function updatePlanLive(): void {
  const pv = document.getElementById('pal-v');
  if (pv) pv.textContent = Number(val('p-pal')).toFixed(2).replace(/0$/, '');
  const box = document.getElementById('planres');
  if (!box) return;
  const x = planFromForm();
  box.innerHTML = x ? planResultHtml(x.r) : '<p class="muted small">Completa edad, estatura y peso para ver tu plan.</p>';
}
function savePlan(): void {
  const x = planFromForm();
  if (!x || !x.r) { toast('Completa edad, estatura y peso.'); return; }
  if ('error' in x.r) { toast(x.r.error); return; }
  const today = localDate();
  S.data.profile = x.p;
  S.data.weights[today] = x.p.weightKg;
  const day = (S.data.days[today] ??= { entries: [] });
  day.target = x.r.target;
  commit();
  toast('Plan guardado');
  S.tab = 'hoy';
  S.date = today;
  render();
}

// ── Samsung Health ──
async function onSamsungFiles(files: FileList): Promise<void> {
  const csvs: CsvFile[] = [];
  const problems: string[] = [];
  for (const f of Array.from(files)) {
    try {
      if (/\.zip$/i.test(f.name)) csvs.push(...(await readZipTexts(await f.arrayBuffer(), (n) => /\.csv$/i.test(n))));
      else csvs.push({ name: f.name, text: await f.text() });
    } catch (e) {
      problems.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const res = importSamsung(csvs);
  res.report.unshift(...problems);
  S.imp = res;
  const box = document.getElementById('sh-report');
  if (box) box.innerHTML = impHtml();
}
function applyImport(): void {
  const i = S.imp;
  if (!i) return;
  for (const [d, n] of Object.entries(i.steps)) (S.data.days[d] ??= { entries: [] }).steps = n;
  for (const [d, s] of Object.entries(i.sleep)) {
    const day = (S.data.days[d] ??= { entries: [] });
    day.sleepMin = s.min;
    if (s.stages) day.sleepStages = s.stages; else delete day.sleepStages;
  }
  let w = 0;
  for (const [d, x] of Object.entries(i.weights)) if (S.data.weights[d] === undefined) { S.data.weights[d] = x.kg; w++; }
  commit();
  toast(`Importado: ${Object.keys(i.steps).length} días de pasos, ${Object.keys(i.sleep).length} de sueño, ${w} pesajes nuevos`);
  S.imp = null;
  render();
}

async function runDiag(): Promise<void> {
  const out: string[] = [];
  const put = () => { S.diag = [...out]; const ul = document.getElementById('diag'); if (ul) ul.innerHTML = out.map((x) => `<li>${x.replace(/</g, '&lt;')}</li>`).join(''); };
  out.push('Open Food Facts: probando…'); put();
  try {
    const t0 = performance.now();
    const r = await off.getProductByBarcode('3017620422003');
    out[0] = `Open Food Facts: conectado (${Math.round(performance.now() - t0)} ms, ${r.status === 'found' ? 'producto de prueba encontrado' : 'sin producto de prueba'}).`;
  } catch (e) {
    out[0] = `Open Food Facts: sin conexión (${e instanceof Error ? e.message : String(e)}).`;
  }
  out.push(`Lector de códigos (BarcodeDetector): ${scannerSupported() ? 'disponible' : 'no disponible'}.`);
  out.push(`Cámara: ${cameraSupported() ? 'disponible' : 'no disponible (sin BarcodeDetector o sin permiso)'}.`);
  out.push(`Contexto seguro (https): ${isSecureContext ? 'sí' : 'no — la cámara y la instalación requieren https'}.`);
  out.push(`Service worker (uso sin conexión): ${'serviceWorker' in navigator && navigator.serviceWorker.controller ? 'activo' : 'inactivo'}.`);
  out.push('Samsung Health en vivo: no disponible desde la web (requiere app nativa con Health Connect).');
  put();
}

function exportBackup(): void {
  const blob = new Blob([JSON.stringify(S.data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `nutriapp-respaldo-${localDate()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ── Eventos ──
document.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const a = el.dataset['act'];
  const d = el.dataset;
  switch (a) {
    case 'tab': S.tab = d['t'] as typeof S.tab; render(); window.scrollTo(0, 0); break;
    case 'day': S.date = addDays(S.date, Number(d['d'])); render(); break;
    case 'today': S.date = localDate(); render(); break;
    case 'add': sh.openAdd(d['slot'] as SlotId); break;
    case 'close': sh.closeSheet(); break;
    case 'mode': { const s = S.sheet; if (s?.kind === 'add') { sh.stopLive(); s.mode = d['m'] as typeof s.mode; s.scanning = false; s.status = ''; renderSheet(); } break; }
    case 'pick-food': { const s = S.sheet; const f = S.data.foods[d['id'] as string]; if (s?.kind === 'add' && f) sh.openPortion(f, s.slot); break; }
    case 'pick-off': sh.pickOff(Number(d['i'])); break;
    case 'cam-start': { const s = S.sheet; if (s?.kind === 'add') { s.scanning = true; renderSheet(); } break; }
    case 'cam-stop': { const s = S.sheet; sh.stopLive(); if (s?.kind === 'add') { s.scanning = false; renderSheet(); } break; }
    case 'grams': { (document.getElementById('g') as HTMLInputElement).value = d['g'] as string; sh.updatePortionPreview(); break; }
    case 'portion-save': sh.savePortion(); break;
    case 'entry-del': sh.deleteEntry(); break;
    case 'edit-entry': {
      const e = S.data.days[S.date]?.entries.find((x) => x.id === d['id']);
      if (!e) break;
      const f = (e.foodId && S.data.foods[e.foodId]) || { id: e.foodId ?? 'x', name: e.name, brand: null, barcode: null, source: 'user' as const, servingG: null, createdAt: 0, per100: { kcal: (e.kcal * 100) / e.grams, protein: (e.protein * 100) / e.grams, carbs: (e.carbs * 100) / e.grams, fat: (e.fat * 100) / e.grams, fiber: (e.fiber * 100) / e.grams, sodium: null } };
      sh.openPortion(f, e.slot, e.id, e.grams);
      break;
    }
    case 'new-food': sh.openManual(null); break;
    case 'edit-food': sh.openFoodEdit(d['id'] as string); break;
    case 'food-del': sh.deleteFood(); break;
    case 'new-recipe': sh.openRecipe(null); break;
    case 'edit-recipe': sh.openRecipe(d['id'] as string); break;
    case 'ing-add': sh.addIngredient(d['id'] as string); break;
    case 'ing-del': sh.delIngredient(Number(d['k'])); break;
    case 'recipe-save': sh.saveRecipe(); break;
    case 'recipe-del': sh.deleteRecipe(); break;
    case 'activity': S.sheet = { kind: 'activity', date: S.date }; renderSheet(); break;
    case 'range': S.range = Number(d['r']); render(); break;
    case 'wtable': { const t = document.getElementById('wtable'); if (t) t.hidden = !t.hidden; break; }
    case 'save-plan': savePlan(); break;
    case 'apply-import': applyImport(); break;
    case 'diag': void runDiag(); break;
    case 'export': exportBackup(); break;
  }
});

document.addEventListener('submit', (ev) => {
  const form = ev.target as HTMLFormElement;
  const kind = form.dataset['form'];
  if (!kind) return;
  ev.preventDefault();
  if (kind === 'search') void sh.runSearch(val('q'));
  else if (kind === 'code') void sh.lookupBarcode(val('code'));
  else if (kind === 'manual') sh.saveManual();
  else if (kind === 'activity') sh.saveActivity();
  else if (kind === 'weight') {
    const w = parseNum(val('w-kg'));
    if (w === null || w < 25 || w > 400) { toast('Ingresa un peso válido en kg.'); return; }
    S.data.weights[localDate()] = Math.round(w * 10) / 10;
    commit(); toast('Peso guardado'); render();
  } else if (kind === 'measures') {
    const m: Partial<Record<MeasureKey, number>> = {};
    for (const [k] of MEASURE_KEYS) { const v = parseNum(val(`m-${k}`)); if (v !== null && v > 5 && v < 300) m[k] = v; }
    if (!Object.keys(m).length) { toast('Ingresa al menos una medida.'); return; }
    S.data.measures[localDate()] = { ...S.data.measures[localDate()], ...m };
    commit(); toast('Medidas guardadas'); render();
  }
});

document.addEventListener('input', (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === 'g') sh.updatePortionPreview();
  else if (t.id === 'mf') { const l = document.getElementById('minelist'); if (l) { const s = S.sheet; if (s?.kind === 'add') l.innerHTML = sh.recipePoolHtml(t.value).replace(/data-act="ing-add"/g, 'data-act="pick-food"') || '<p class="muted small">Sin coincidencias.</p>'; } }
  else if (t.id === 'rq') { const l = document.getElementById('rlist'); if (l) l.innerHTML = sh.recipePoolHtml(t.value); }
  else if (t.classList.contains('ig') || t.id === 'r-serv') { sh.syncDraft(); const s = S.sheet; if (s?.kind === 'recipe') $('rtot').innerHTML = sh.recipeTotalsHtml(s.draft); }
  else if (t.closest('#planform')) updatePlanLive();
});
document.addEventListener('change', (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === 'sh-file' && t.files?.length) void onSamsungFiles(t.files);
  else if (t.id === 'bk-file' && t.files?.[0]) {
    void t.files[0].text().then((txt) => {
      try { Object.assign(S.data, migrate(JSON.parse(txt))); saveData(S.data); toast('Respaldo importado'); render(); } catch (e) { toast(e instanceof Error ? e.message : 'Respaldo inválido'); }
    });
  } else if (t.id === 'photo' && t.files?.[0]) void sh.scanPhoto(t.files[0]);
  else if (t.closest('#planform')) updatePlanLive();
});

// Tooltips de gráficos (toque o puntero)
const tip = $('tip');
document.addEventListener('pointerdown', (ev) => {
  const el = (ev.target as Element).closest('[data-tip]');
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.getAttribute('data-tip') ?? '';
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
  tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
});
document.addEventListener('pointerover', (ev) => { if ((ev as PointerEvent).pointerType === 'mouse') (ev.target as Element).closest('[data-tip]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });

window.addEventListener('pagehide', () => saveData(S.data));
void recipeOfFood;
void currentTarget;

render();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost') && !location.search.includes('nosw')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
