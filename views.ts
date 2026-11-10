import { barChart, ring, weightChart, type Bar } from '../lib/charts';
import {
  actualRateKgPerWeek, avgSteps7, computePlan, isPersistent, latestWeight, MEASURE_KEYS, SLOTS, sumEntries, weeklyTrend, weightEma,
  type Entry, type Target,
} from '../lib/model';
import { addDays, esc, fmt, localDate, longDate, shortDate } from '../lib/util';
import { cameraSupported, scannerSupported } from '../lib/scanner';
import { S } from './state';

const WARN: Record<string, string> = {
  KCAL_FLOOR_APPLIED: 'Se aplicó el piso calórico de seguridad: el déficit se recortó.',
  RATE_CAPPED: 'Se alcanzó el tope de ritmo seguro (% del peso por semana).',
  HORIZON_EXTENDED: 'El plazo pedido exigía un ritmo no permitido; se alargó.',
  MACRO_BUDGET_TIGHT: 'Proteína y grasa mínima casi no caben en las calorías objetivo.',
};
const LIMIT: Record<string, string> = { none: 'Sin restricciones activas.', tdee_window: 'Limitado por la ventana de % del gasto.', rate_cap: 'Limitado por el ritmo máximo seguro.', kcal_floor: 'Limitado por el piso calórico.' };

export function currentTarget(): { target: Target | null; err: string | null; note: string | null } {
  const r = computePlan(S.data, localDate());
  if (!r) return { target: null, err: null, note: null };
  if ('error' in r) return { target: null, err: r.error, note: null };
  return { target: r.target, err: null, note: r.note };
}

function macroRow(label: string, cls: string, v: number, t: number, unit = 'g'): string {
  const pct = t > 0 ? Math.min(100, (v / t) * 100) : 0;
  const left = t - v;
  return `<div class="macro"><div class="macro-h"><span class="dot ${cls}"></span><span class="macro-n">${label}</span><span class="macro-v">${fmt(v)} / ${fmt(t)} ${unit}</span></div>
    <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>
    <div class="macro-s">${left >= 0 ? `Faltan ${fmt(left)} ${unit}` : `+${fmt(-left)} ${unit} sobre el objetivo`}</div></div>`;
}

function entryRow(e: Entry): string {
  return `<button class="row" data-act="edit-entry" data-id="${esc(e.id)}"><span class="row-main"><b>${esc(e.name)}</b><small>${fmt(e.grams)} g · P ${fmt(e.protein)} · C ${fmt(e.carbs)} · G ${fmt(e.fat)}</small></span><span class="row-v">${fmt(e.kcal)} kcal</span></button>`;
}

export function viewHoy(): string {
  const day = S.data.days[S.date];
  const entries = day?.entries ?? [];
  const tot = sumEntries(entries);
  const { target: cur, err, note } = currentTarget();
  const target = day?.target ?? cur;
  const isToday = S.date === localDate();
  const nav = `<div class="datenav"><button class="icon-btn" data-act="day" data-d="-1" aria-label="Día anterior">‹</button><button class="datelabel" data-act="today">${isToday ? 'Hoy' : esc(longDate(S.date))}<small>${isToday ? esc(longDate(S.date)) : 'Ir a hoy'}</small></button><button class="icon-btn" data-act="day" data-d="1" aria-label="Día siguiente">›</button></div>`;
  let summary: string;
  if (!target) {
    summary = `<section class="card"><h2>Define tu plan</h2><p class="muted">${err ? esc(err) : 'Ingresa tus datos para calcular calorías y macros objetivo.'}</p><button class="btn primary" data-act="tab" data-t="plan">Configurar perfil</button></section>`;
  } else {
    const remaining = target.kcal - tot.kcal;
    summary = `<section class="card hero">
      <div class="ring-wrap">${ring(tot.kcal, target.kcal)}<div class="ring-c"><div class="big">${fmt(Math.abs(remaining))}</div><div class="muted small">${remaining >= 0 ? 'kcal restantes' : 'kcal sobre el objetivo'}</div></div></div>
      <div class="hero-meta"><div><b>${fmt(tot.kcal)}</b><span class="muted small">consumidas</span></div><div><b>${fmt(target.kcal)}</b><span class="muted small">objetivo</span></div></div>
      <div class="macros">${macroRow('Proteína', 'c-protein', tot.protein, target.protein)}${macroRow('Carbohidratos', 'c-carbs', tot.carbs, target.carbs)}${macroRow('Grasas', 'c-fat', tot.fat, target.fat)}${macroRow('Fibra', 'c-fiber', tot.fiber, target.fiber)}</div>
      ${note ? `<p class="muted small">${esc(note)}</p>` : ''}</section>`;
  }
  const act = `<section class="card"><div class="card-h"><h2>Actividad y sueño</h2><button class="link" data-act="activity">Editar</button></div>
    <div class="stats"><div><b>${day?.steps !== undefined ? fmt(day.steps) : '—'}</b><span class="muted small">pasos</span></div>
    <div><b>${day?.sleepMin !== undefined ? `${Math.floor(day.sleepMin / 60)} h ${String(day.sleepMin % 60).padStart(2, '0')} min` : '—'}</b><span class="muted small">sueño</span></div></div>
    ${day?.sleepStages ? `<p class="muted small">Profundo ${day.sleepStages.deep} min · REM ${day.sleepStages.rem} min · Ligero ${day.sleepStages.light} min · Despierto ${day.sleepStages.awake} min</p>` : ''}</section>`;
  const slots = SLOTS.map((s) => {
    const es = entries.filter((e) => e.slot === s.id);
    const k = sumEntries(es).kcal;
    return `<section class="card slot"><div class="card-h"><h2>${s.label}</h2><span class="muted">${fmt(k)} kcal</span></div>${es.map(entryRow).join('')}<button class="btn ghost" data-act="add" data-slot="${s.id}">+ Agregar alimento</button></section>`;
  }).join('');
  return nav + summary + act + slots;
}

export function viewAlimentos(): string {
  const foods = Object.values(S.data.foods).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const recipes = Object.values(S.data.recipes).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const frow = (f: (typeof foods)[number]) => `<button class="row" data-act="edit-food" data-id="${esc(f.id)}"><span class="row-main"><b>${esc(f.name)}</b><small>${esc(f.brand ?? (f.source === 'off' ? 'Open Food Facts' : f.source === 'recipe' ? 'Receta' : 'Manual'))}${f.barcode ? ` · ${esc(f.barcode)}` : ''}</small></span><span class="row-v">${fmt(f.per100.kcal)} kcal/100 g</span></button>`;
  return `<section class="card"><div class="card-h"><h2>Recetas</h2><button class="link" data-act="new-recipe">+ Nueva</button></div>
    ${recipes.length ? recipes.map((r) => `<button class="row" data-act="edit-recipe" data-id="${esc(r.id)}"><span class="row-main"><b>${esc(r.name)}</b><small>${r.ingredients.length} ingredientes · ${r.servings} porciones</small></span></button>`).join('') : '<p class="muted small">Crea recetas sumando ingredientes por gramos.</p>'}</section>
    <section class="card"><div class="card-h"><h2>Mis alimentos</h2><button class="link" data-act="new-food">+ Manual</button></div>
    ${foods.length ? foods.map(frow).join('') : '<p class="muted small">Los alimentos que escanees, busques o crees quedan guardados aquí para reutilizarlos.</p>'}</section>`;
}

export function viewProgreso(): string {
  const d = S.data;
  const today = localDate();
  const pts = weightEma(d.weights);
  const shown = pts.filter((p) => p.date >= addDays(today, -S.range));
  const rate = actualRateKgPerWeek(pts);
  const plan = computePlan(d, today);
  const planned = plan && 'plan' in plan ? plan.plan.energy.weeklyKg : null;
  const last = pts[pts.length - 1];
  const wk = weeklyTrend(d, 8, today);
  const kcalBars: Bar[] = wk.map((w) => ({ label: shortDate(w.start), value: w.avgKcal, tip: `Semana del ${shortDate(w.start)} · ${w.avgKcal === null ? 'sin registros' : `${fmt(w.avgKcal)} kcal/día (${w.loggedDays} días)`}` }));
  const dBars: Bar[] = wk.map((w) => ({ label: shortDate(w.start), value: w.deltaKg, tip: `Semana del ${shortDate(w.start)} · ${w.deltaKg === null ? 'sin datos' : `${w.deltaKg > 0 ? '+' : ''}${fmt(w.deltaKg, 2)} kg (tendencia)`}` }));
  const days14 = Array.from({ length: 14 }, (_, i) => addDays(today, i - 13));
  const stepBars: Bar[] = days14.map((x) => { const v = d.days[x]?.steps; return { label: shortDate(x).split(' ')[0] as string, value: v ?? null, tip: `${shortDate(x)} · ${v === undefined ? 'sin dato' : `${fmt(v)} pasos`}` }; });
  const sleepBars: Bar[] = days14.map((x) => { const v = d.days[x]?.sleepMin; return { label: shortDate(x).split(' ')[0] as string, value: v === undefined ? null : Math.round((v / 60) * 10) / 10, tip: `${shortDate(x)} · ${v === undefined ? 'sin dato' : `${Math.floor(v / 60)} h ${v % 60} min`}` }; });
  const kcalTarget = currentTarget().target?.kcal;
  const lastM = (k: string) => { const dates = Object.keys(d.measures).filter((x) => (d.measures[x] as Record<string, number>)[k] !== undefined).sort(); const a = dates[dates.length - 1]; const b = dates[dates.length - 2]; const va = a ? (d.measures[a] as Record<string, number>)[k] : undefined; const vb = b ? (d.measures[b] as Record<string, number>)[k] : undefined; return { va, delta: va !== undefined && vb !== undefined ? va - vb : null, at: a }; };
  return `<section class="card"><div class="card-h"><h2>Peso</h2><div class="seg" role="group" aria-label="Rango">${[30, 90, 365].map((r) => `<button class="${S.range === r ? 'on' : ''}" data-act="range" data-r="${r}">${r === 365 ? '1 año' : `${r} d`}</button>`).join('')}</div></div>
    <form id="wform" class="inline-form" data-form="weight"><label class="field grow"><span>Peso de hoy (kg)</span><input id="w-kg" inputmode="decimal" placeholder="${last ? fmt(last.w, 1) : '75,0'}" autocomplete="off"></label><button class="btn primary" type="submit">Guardar</button></form>
    ${shown.length ? `<div class="legend"><span><i class="lg-dot"></i>Pesaje</span><span><i class="lg-line"></i>Tendencia (EMA 7 d)</span></div>${weightChart(shown)}` : '<p class="muted small">Registra tu peso cada día: la tendencia suaviza las oscilaciones.</p>'}
    <div class="stats"><div><b>${last ? `${fmt(last.ema, 1)} kg` : '—'}</b><span class="muted small">tendencia actual</span></div><div><b>${rate === null ? '—' : `${rate > 0 ? '+' : ''}${fmt(rate, 2)} kg/sem`}</b><span class="muted small">ritmo real (21 d)</span></div><div><b>${planned === null ? '—' : `${planned > 0 ? '+' : ''}${fmt(planned, 2)} kg/sem`}</b><span class="muted small">ritmo del plan</span></div></div>
    <button class="table-toggle link" data-act="wtable">Ver tabla</button><div id="wtable" hidden>${pts.slice(-30).reverse().map((p) => `<div class="trow"><span>${shortDate(p.date)}</span><span>${fmt(p.w, 1)} kg</span><span>${fmt(p.ema, 1)} kg</span></div>`).join('')}</div></section>
    <section class="card"><h2>Ingesta semanal</h2><p class="muted small">kcal/día promedio de los días con registro${kcalTarget ? ` · línea: objetivo ${fmt(kcalTarget)}` : ''}</p>${barChart(kcalBars, { cls: 'c-kcal', unit: 'kcal', refLine: kcalTarget })}
    <h2 class="sub">Cambio de peso semanal</h2><p class="muted small">kg de variación de la tendencia (azul baja, rojo sube)</p>${barChart(dBars, { cls: 'c-kcal', signed: true, unit: 'kg', digits: 1 })}</section>
    <section class="card"><h2>Pasos (14 días)</h2>${barChart(stepBars, { cls: 'c-steps', unit: 'pasos' })}<h2 class="sub">Sueño (horas)</h2>${barChart(sleepBars, { cls: 'c-sleep', unit: 'h', digits: 1 })}<p class="muted small">Promedio de pasos 7 días: ${fmt(avgSteps7(d, today))}</p></section>
    <section class="card"><h2>Medidas corporales (cm)</h2><form id="mform" data-form="measures" class="grid2">${MEASURE_KEYS.map(([k, label]) => { const m = lastM(k); return `<label class="field"><span>${label}${m.va !== undefined ? ` · ${fmt(m.va, 1)}${m.delta !== null && m.delta !== 0 ? ` (${m.delta > 0 ? '+' : ''}${fmt(m.delta, 1)})` : ''}` : ''}</span><input id="m-${k}" inputmode="decimal" autocomplete="off" placeholder="${m.va !== undefined ? fmt(m.va, 1) : ''}"></label>`; }).join('')}<button class="btn primary span2" type="submit">Guardar medidas de hoy</button></form></section>`;
}

export function planFormHtml(): string {
  const p = S.data.profile;
  const v = (x: unknown, d = '') => esc(x ?? d);
  const sel = (id: string, opts: [string, string][], cur: string) => `<select id="${id}">${opts.map(([val, lab]) => `<option value="${val}"${val === cur ? ' selected' : ''}>${lab}</option>`).join('')}</select>`;
  return `<form id="planform" class="grid2" data-form="plan" autocomplete="off">
    <label class="field"><span>Sexo</span>${sel('p-sex', [['male', 'Hombre'], ['female', 'Mujer']], p?.sex ?? 'male')}</label>
    <label class="field"><span>Edad</span><input id="p-age" inputmode="numeric" value="${v(p?.age)}"></label>
    <label class="field"><span>Estatura (cm)</span><input id="p-h" inputmode="decimal" value="${v(p?.heightCm)}"></label>
    <label class="field"><span>Peso (kg)</span><input id="p-w" inputmode="decimal" value="${v(latestWeight(S.data) ?? p?.weightKg)}"></label>
    <label class="field"><span>% grasa (opcional)</span><input id="p-bf" inputmode="decimal" value="${v(p?.bodyFatPct)}" placeholder="—"></label>
    <label class="field"><span>Peso objetivo (opcional)</span><input id="p-tw" inputmode="decimal" value="${v(p?.targetWeightKg)}" placeholder="—"></label>
    <label class="field"><span>Meta</span>${sel('p-goal', [['lose', 'Perder grasa'], ['maintain', 'Mantener'], ['gain', 'Ganar masa']], p?.goal ?? 'maintain')}</label>
    <label class="field"><span>Plazo</span>${sel('p-hor', [['short', 'Corto (8 sem)'], ['medium', 'Medio (16 sem)'], ['long', 'Largo (32 sem)']], p?.horizon ?? 'medium')}</label>
    <label class="field"><span>Experiencia</span>${sel('p-exp', [['beginner', 'Principiante'], ['intermediate', 'Intermedio'], ['advanced', 'Avanzado']], p?.experience ?? 'intermediate')}</label>
    <label class="field"><span>Gasto diario según</span>${sel('p-act', [['pal', 'Nivel de actividad (PAL)'], ['steps', 'Pasos (Samsung Health)']], p?.activity ?? 'pal')}</label>
    <label class="field span2"><span>Nivel de actividad (PAL) <b id="pal-v">${v(p?.pal, '1.5')}</b></span><input id="p-pal" type="range" min="1.2" max="1.9" step="0.05" value="${v(p?.pal, '1.5')}"><small class="muted">1,2 sedentario · 1,5 moderado · 1,9 muy activo. En modo pasos se ignora.</small></label>
  </form>`;
}

export function planResultHtml(r: ReturnType<typeof computePlan>): string {
  if (!r) return '';
  if ('error' in r) return `<p class="err">${esc(r.error)}</p>`;
  const { plan: p, target: t } = r;
  const e = p.energy;
  return `<div class="stats"><div><b>${fmt(t.kcal)}</b><span class="muted small">kcal objetivo</span></div><div><b>${fmt(p.tdee.kcal)}</b><span class="muted small">gasto (TDEE)</span></div><div><b>${e.dailyDeltaKcal > 0 ? '+' : ''}${fmt(e.dailyDeltaKcal)}</b><span class="muted small">kcal/día vs gasto</span></div></div>
    <div class="macros">${[['Proteína', 'c-protein', t.protein], ['Carbohidratos', 'c-carbs', t.carbs], ['Grasas', 'c-fat', t.fat], ['Fibra', 'c-fiber', t.fiber]].map(([l, c, g]) => `<div class="mrow"><span class="dot ${c}"></span><span>${l}</span><b>${fmt(g as number)} g</b></div>`).join('')}</div>
    <p class="muted small">BMR ${fmt(p.bmr.kcal)} kcal (${p.bmr.method === 'katch-mcardle' ? 'Katch-McArdle' : 'Mifflin-St Jeor'}). Ritmo ${e.weeklyKg > 0 ? '+' : ''}${fmt(e.weeklyKg, 2)} kg/sem (${fmt(e.weeklyPctBodyWeight, 2)} % del peso). ${LIMIT[e.limitedBy] ?? ''} Gasto calculado con ${r.usedModel === 'steps' ? 'pasos' : 'PAL'}.</p>
    ${r.note ? `<p class="warn">${esc(r.note)}</p>` : ''}${p.warnings.map((w) => `<p class="warn">${esc(WARN[w] ?? w)}</p>`).join('')}`;
}

export function viewPlan(): string {
  const r = computePlan(S.data, localDate());
  const standalone = matchMedia('(display-mode: standalone)').matches;
  return `<section class="card"><h2>Perfil y meta</h2>${planFormHtml()}<div id="planres" class="planres">${planResultHtml(r)}</div><button class="btn primary" data-act="save-plan">Guardar plan</button></section>
    <section class="card"><h2>Samsung Health</h2>
    <p class="muted small">Una página web no puede leer Samsung Health directamente (solo las apps nativas de Android acceden a Health Connect). Exporta tus datos y cárgalos aquí: pasos, sueño y peso.</p>
    <ol class="steps"><li>Samsung Health → ⋮ → Ajustes → <b>Descargar datos personales</b>.</li><li>Elige el ZIP (o los .csv) abajo.</li></ol>
    <label class="btn ghost filebtn">Cargar ZIP o CSV de Samsung Health<input id="sh-file" type="file" multiple accept=".zip,.csv,text/csv,application/zip" hidden></label>
    <div id="sh-report">${S.imp ? impHtml() : ''}</div></section>
    <section class="card"><h2>Conexiones</h2><button class="btn ghost" data-act="diag">Comprobar conexiones</button><ul class="diag" id="diag">${S.diag.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="muted small">Escáner: ${scannerSupported() ? 'disponible' : 'no disponible (usa el número)'} · Cámara: ${cameraSupported() ? 'disponible' : 'no disponible'} · App instalada: ${standalone ? 'sí' : 'no'} · Guardado local: ${isPersistent() ? 'activo' : 'limitado'}</p></section>
    <section class="card"><h2>Respaldo</h2><p class="muted small">Tus datos viven solo en este teléfono. Exporta un respaldo de vez en cuando.</p>
    <div class="btnrow"><button class="btn ghost" data-act="export">Exportar respaldo</button><label class="btn ghost filebtn">Importar<input id="bk-file" type="file" accept=".json,application/json" hidden></label></div></section>`;
}

export function impHtml(): string {
  const i = S.imp;
  if (!i) return '';
  const ns = Object.keys(i.steps).length, nl = Object.keys(i.sleep).length, nw = Object.keys(i.weights).length;
  return `<div class="importbox"><p><b>${ns}</b> días de pasos · <b>${nl}</b> noches de sueño · <b>${nw}</b> pesajes</p><ul class="diag">${i.report.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${ns + nl + nw ? '<button class="btn primary" data-act="apply-import">Aplicar a mis datos</button>' : ''}</div>`;
}
