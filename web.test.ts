import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { importSamsung, parseCsv, readTable } from '../web/src/lib/samsung';
import { readZipTexts } from '../web/src/lib/zip';
import { actualRateKgPerWeek, computePlan, emptyData, migrate, portion, recipeNutrition, sumEntries, weeklyTrend, weightEma, type AppData, type Food } from '../web/src/lib/model';
import { addDays, weekStart } from '../web/src/lib/util';

// ── ZIP de prueba (stored + deflate) ──
function makeZip(files: Record<string, string>, deflate: boolean): ArrayBuffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    parts.push(lh, nm, data);
    central.push(ch, nm);
    offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...parts, cd, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length) as ArrayBuffer;
}

test('zip: lee archivos stored y deflate, y filtra por nombre', async () => {
  for (const deflate of [false, true]) {
    const z = makeZip({ 'a/x.csv': 'hola,ñandú\n1,2', 'b.txt': 'no' }, deflate);
    const r = await readZipTexts(z, (n) => n.endsWith('.csv'));
    assert.deepEqual(r, [{ name: 'a/x.csv', text: 'hola,ñandú\n1,2' }]);
  }
  await assert.rejects(() => readZipTexts(new ArrayBuffer(10), () => true), /ZIP/);
});

test('csv: comillas, saltos CRLF y fila de metadatos antes del encabezado', () => {
  assert.deepEqual(parseCsv('a,"b,c"\r\n"x""y",2\n'), [['a', 'b,c'], ['x"y', '2']]);
  const t = readTable('com.samsung.shealth.step_daily_trend,123,2\nday_time,count,source_type\n1699142400000,5000,-2\n');
  assert.ok(t);
  assert.equal(t.rows.length, 1);
  assert.equal(t.cols.get('count'), 1);
});

const TREND = 'com.samsung.shealth.step_daily_trend,1,3\nday_time,count,distance\n1699142400000,5000,1\n1699142400000,7200,1\n1699228800000,3000,1\n';
const SLEEP = 'com.samsung.shealth.sleep,1,5\ndatauuid,start_time,end_time,time_offset,sleep_duration\nS1,2023-11-05 02:00:00.000,2023-11-05 10:00:00.000,-10800000,480\n';
const STAGES = 'com.samsung.health.sleep_stage,1,4\nsleep_id,start_time,end_time,stage\nS1,2023-11-05 02:00:00.000,2023-11-05 03:00:00.000,40002\nS1,2023-11-05 03:00:00.000,2023-11-05 04:30:00.000,40003\nS1,2023-11-05 04:30:00.000,2023-11-05 05:00:00.000,40004\nS1,2023-11-05 05:00:00.000,2023-11-05 05:15:00.000,40001\n';
const WEIGHT = 'com.samsung.health.weight,1,4\nstart_time,time_offset,weight,body_fat\n2023-11-05 11:00:00.000,-10800000,82.46,18.2\n';

test('samsung: pasos (máximo por día), sueño con etapas, peso y zona horaria', () => {
  const r = importSamsung([
    { name: 'com.samsung.shealth.step_daily_trend.20231105.csv', text: TREND },
    { name: 'com.samsung.shealth.sleep.20231105.csv', text: SLEEP },
    { name: 'com.samsung.health.sleep_stage.20231105.csv', text: STAGES },
    { name: 'com.samsung.health.weight.20231105.csv', text: WEIGHT },
  ]);
  assert.deepEqual(r.steps, { '2023-11-05': 7200, '2023-11-06': 3000 });
  // Sueño terminó 10:00 UTC = 07:00 local (−3 h) → fecha 2023-11-05
  assert.deepEqual(r.sleep['2023-11-05'], { min: 480, stages: { awake: 15, light: 60, deep: 90, rem: 30 } });
  assert.deepEqual(r.weights['2023-11-05'], { kg: 82.5, bodyFat: 18.2 });
});

test('samsung: sin archivos conocidos informa y no inventa datos', () => {
  const r = importSamsung([{ name: 'otra-cosa.csv', text: 'a,b\n1,2' }]);
  assert.deepEqual(r.steps, {});
  assert.match(r.report.join(' '), /No se encontró/);
});

// ── Modelo ──
const F = (id: string, k: number, p: number, c: number, f: number): Food => ({ id, name: id, brand: null, barcode: null, source: 'user', per100: { kcal: k, protein: p, carbs: c, fat: f, fiber: null, sodium: null }, servingG: null, createdAt: 0 });

test('porciones y recetas: totales, por 100 g y por porción', () => {
  assert.deepEqual(portion(F('x', 200, 10, 20, 5).per100, 150), { kcal: 300, protein: 15, carbs: 30, fat: 7.5, fiber: 0 });
  const foods = { a: F('a', 100, 10, 0, 0), b: F('b', 400, 0, 80, 0) };
  const r = recipeNutrition([{ foodId: 'a', name: 'a', grams: 200 }, { foodId: 'b', name: 'b', grams: 50 }, { foodId: 'zz', name: 'q', grams: 99 }], foods, 2);
  assert.equal(r.grams, 250);
  assert.equal(r.total.kcal, 400);
  assert.equal(r.per100.kcal, 160);
  assert.equal(r.perServing.kcal, 200);
  assert.equal(sumEntries([]).kcal, 0);
});

test('EMA de 7 días y ritmo real', () => {
  const w: Record<string, number> = {};
  for (let i = 0; i < 28; i++) w[addDays('2026-01-01', i)] = 80 - i * (0.5 / 7); // −0.5 kg/semana exactos
  const pts = weightEma(w);
  assert.equal(pts[0]?.ema, 80);
  const rate = actualRateKgPerWeek(pts);
  assert.ok(rate !== null && Math.abs(rate + 0.5) < 0.02, `rate=${rate}`);
  assert.equal(actualRateKgPerWeek(pts.slice(0, 2)), null);
});

test('plan: usa el motor, pasos con respaldo a PAL y errores legibles', () => {
  const d: AppData = emptyData();
  assert.equal(computePlan(d, '2026-01-10'), null);
  d.profile = { sex: 'male', age: 30, heightCm: 175, weightKg: 75, bodyFatPct: null, experience: 'intermediate', goal: 'lose', horizon: 'medium', targetWeightKg: null, activity: 'steps', pal: 1.5 };
  const r = computePlan(d, '2026-01-10');
  assert.ok(r && 'plan' in r);
  assert.equal(r.usedModel, 'pal');
  assert.match(r.note ?? '', /Sin datos de pasos/);
  d.days['2026-01-09'] = { entries: [], steps: 9000 };
  const r2 = computePlan(d, '2026-01-10');
  assert.ok(r2 && 'plan' in r2 && r2.usedModel === 'steps');
  d.profile.age = 12;
  const bad = computePlan(d, '2026-01-10');
  assert.ok(bad && 'error' in bad);
});

test('tendencia semanal: ingesta media y cambio de EMA', () => {
  const d = emptyData();
  const today = '2026-02-15'; // domingo
  const mon = weekStart(today);
  for (let i = -8; i <= 0; i++) d.weights[addDays(today, i)] = 80 - i * 0.05; // baja hacia hoy
  d.days[mon] = { entries: [{ id: '1', slot: 'cena', name: 'x', grams: 1, kcal: 2000, protein: 0, carbs: 0, fat: 0, fiber: 0, foodId: null, ts: 0 }] };
  const rows = weeklyTrend(d, 2, today);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.avgKcal, 2000);
  assert.equal(rows[1]?.loggedDays, 1);
  assert.ok((rows[1]?.deltaKg ?? 0) < 0);
});

test('migrate rechaza respaldos inválidos', () => {
  assert.throws(() => migrate(null));
  assert.throws(() => migrate({ v: 2 }));
  assert.equal(migrate({ v: 1 }).profile, null);
});
