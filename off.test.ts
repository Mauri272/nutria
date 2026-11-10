import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { isComplete, scaleNutrients } from '../src/domain/food';
import { runMigrations, type SqlExecutor } from '../src/db/migrate';
import {
  OpenFoodFactsClient,
  OffError,
  gtinCheckDigit,
  mapProduct,
  normalizeBarcode,
  toFoodRecord,
  type FetchLike,
  type FetchResponseLike,
  type OffErrorCode,
} from '../src/services/openFoodFacts';

// ───────────────────────────── utilidades de test ─────────────────────────────

interface Call {
  url: string;
  headers: Record<string, string>;
}

function res(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

/** fetch simulado: consume una lista de resultados (respuesta o error) y registra cada llamada. */
function scripted(steps: Array<FetchResponseLike | Error>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step === undefined) throw new Error('scripted: sin pasos');
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetch, calls };
}

function client(fetch: FetchLike, extra: Partial<ConstructorParameters<typeof OpenFoodFactsClient>[0]> = {}) {
  const sleeps: number[] = [];
  const c = new OpenFoodFactsClient({
    appName: 'TestApp',
    appVersion: '0.0.1',
    contact: 'https://example.test/contact',
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { c, sleeps };
}

async function errorCode(promise: Promise<unknown>): Promise<OffErrorCode> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof OffError, `se esperaba OffError y llegó: ${String(err)}`);
    return err.code;
  }
  assert.fail('se esperaba que lanzara OffError');
}

const PRODUCT_OK = {
  code: '3017624010701',
  status: 1,
  status_verbose: 'product found',
  product: {
    code: '3017624010701',
    product_name: 'Hazelnut spread',
    product_name_es: 'Crema de avellanas',
    brands: 'Marca Uno,Marca Dos',
    quantity: '400 g',
    serving_size: '15 g',
    serving_quantity: 15,
    nutriments: {
      'energy-kcal_100g': 539,
      energy_100g: 2252,
      proteins_100g: 6.3,
      carbohydrates_100g: 57.5,
      fat_100g: 30.9,
      fiber_100g: 0,
      sodium_100g: 0.0428,
      salt_100g: 0.107,
    },
  },
};

// ───────────────────────────── códigos de barras ─────────────────────────────

describe('códigos de barras', () => {
  it('valida y normaliza EAN-13, EAN-8 y UPC-A (ignora espacios y guiones)', () => {
    assert.deepEqual(normalizeBarcode('3017624010701'), { code: '3017624010701', format: 'EAN-13' });
    assert.deepEqual(normalizeBarcode(' 3017 6240-10701 '), { code: '3017624010701', format: 'EAN-13' });
    assert.deepEqual(normalizeBarcode('96385074'), { code: '96385074', format: 'EAN-8' });
    assert.deepEqual(normalizeBarcode('036000291452'), { code: '0036000291452', format: 'UPC-A' });
    assert.deepEqual(normalizeBarcode('0036000291452'), { code: '0036000291452', format: 'EAN-13' });
  });

  it('rechaza dígito verificador malo, letras y largos no minoristas', () => {
    assert.equal(normalizeBarcode('3017624010702'), null);
    assert.equal(normalizeBarcode('30176240107A1'), null);
    assert.equal(normalizeBarcode('1234567890'), null);
    assert.equal(normalizeBarcode(''), null);
    assert.equal(gtinCheckDigit('400638133393'), 1);
  });
});

// ───────────────────────────── cliente HTTP ─────────────────────────────

describe('OpenFoodFactsClient: consulta exitosa', () => {
  it('manda User-Agent propio, pide solo los campos necesarios y mapea por 100 g', async () => {
    const { fetch, calls } = scripted([res(200, PRODUCT_OK)]);
    const { c } = client(fetch);
    const result = await c.getProductByBarcode('3017624010701');

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers['User-Agent'], 'TestApp/0.0.1 (https://example.test/contact)');
    assert.match(calls[0]?.url ?? '', /^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\/3017624010701\.json\?fields=/);
    assert.match(decodeURIComponent(calls[0]?.url ?? ''), /nutriments/);

    assert.equal(result.status, 'found');
    if (result.status !== 'found') return;
    const p = result.product;
    assert.equal(p.name, 'Crema de avellanas'); // product_name_es tiene prioridad
    assert.equal(p.brand, 'Marca Uno');
    assert.equal(p.servingG, 15);
    assert.deepEqual(p.nutrients, { energyKcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9, fiberG: 0, sodiumMg: 42.8 });
    assert.equal(p.isComplete, true);
    assert.deepEqual(p.warnings, []);
  });

  it('un UPC-A se consulta como EAN-13 con 0 inicial', async () => {
    const { fetch, calls } = scripted([res(200, PRODUCT_OK)]);
    await client(fetch).c.getProductByBarcode('036000291452');
    assert.match(calls[0]?.url ?? '', /\/product\/0036000291452\.json/);
  });
});

describe('OpenFoodFactsClient: producto inexistente', () => {
  it('status 0, HTTP 404 y cuerpo sin product → not_found (no es un error)', async () => {
    for (const r of [res(200, { status: 0, status_verbose: 'product not found' }), res(404, { status: 0 }), res(200, {})]) {
      const { fetch } = scripted([r]);
      assert.deepEqual(await client(fetch).c.getProductByBarcode('3017624010701'), { status: 'not_found', barcode: '3017624010701' });
    }
  });

  it('status=1 sin product es una respuesta corrupta (BAD_RESPONSE)', async () => {
    const { fetch } = scripted([res(200, { status: 1 })]);
    assert.equal(await errorCode(client(fetch).c.getProductByBarcode('3017624010701')), 'BAD_RESPONSE');
  });
});

describe('OpenFoodFactsClient: fallos y reintentos', () => {
  it('reintenta 503 con backoff exponencial y termina bien', async () => {
    const { fetch, calls } = scripted([res(503, null), res(503, null), res(200, PRODUCT_OK)]);
    const { c, sleeps } = client(fetch);
    assert.equal((await c.getProductByBarcode('3017624010701')).status, 'found');
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [500, 1000]);
  });

  it('respeta Retry-After en un 429 (en ms, con tope)', async () => {
    const { fetch } = scripted([res(429, null, { 'retry-after': '3' }), res(200, PRODUCT_OK)]);
    const { c, sleeps } = client(fetch);
    await c.getProductByBarcode('3017624010701');
    assert.deepEqual(sleeps, [3000]);

    const big = scripted([res(429, null, { 'retry-after': '120' }), res(200, PRODUCT_OK)]);
    const second = client(big.fetch);
    await second.c.getProductByBarcode('3017624010701');
    assert.deepEqual(second.sleeps, [10_000]);
  });

  it('agota reintentos: 500 → SERVER, 429 → RATE_LIMITED, y llama exactamente maxRetries + 1 veces', async () => {
    const a = scripted([res(500, null)]);
    assert.equal(await errorCode(client(a.fetch).c.getProductByBarcode('3017624010701')), 'SERVER');
    assert.equal(a.calls.length, 3);
    const b = scripted([res(429, null)]);
    assert.equal(await errorCode(client(b.fetch).c.getProductByBarcode('3017624010701')), 'RATE_LIMITED');
  });

  it('errores de red: reintenta y, si persisten, lanza NETWORK', async () => {
    const ok = scripted([new TypeError('Network request failed'), res(200, PRODUCT_OK)]);
    assert.equal((await client(ok.fetch).c.getProductByBarcode('3017624010701')).status, 'found');
    const bad = scripted([new TypeError('Network request failed')]);
    assert.equal(await errorCode(client(bad.fetch).c.getProductByBarcode('3017624010701')), 'NETWORK');
    assert.equal(bad.calls.length, 3);
  });

  it('no reintenta lo que no se arregla reintentando: HTTP 400, JSON inválido', async () => {
    const a = scripted([res(400, null)]);
    assert.equal(await errorCode(client(a.fetch).c.getProductByBarcode('3017624010701')), 'BAD_RESPONSE');
    assert.equal(a.calls.length, 1);

    const broken: FetchResponseLike = { ...res(200, null), json: async () => Promise.reject(new SyntaxError('Unexpected token')) };
    const b = scripted([broken]);
    assert.equal(await errorCode(client(b.fetch).c.getProductByBarcode('3017624010701')), 'BAD_RESPONSE');
    assert.equal(b.calls.length, 1);
  });

  it('código inválido: falla antes de tocar la red', async () => {
    const { fetch, calls } = scripted([res(200, PRODUCT_OK)]);
    assert.equal(await errorCode(client(fetch).c.getProductByBarcode('123')), 'INVALID_BARCODE');
    assert.equal(calls.length, 0);
  });

  it('timeout: aborta el intento y lanza TIMEOUT', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { c } = client(hang, { timeoutMs: 20, maxRetries: 0 });
    assert.equal(await errorCode(c.getProductByBarcode('3017624010701')), 'TIMEOUT');
  });

  it('cancelación del llamador: ABORTED, sin reintentos y sin llamar a la red si ya estaba cancelada', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const ac = new AbortController();
    const { c } = client(hang, { timeoutMs: 5000 });
    const pending = c.getProductByBarcode('3017624010701', { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    assert.equal(await errorCode(pending), 'ABORTED');

    const spy = scripted([res(200, PRODUCT_OK)]);
    const pre = new AbortController();
    pre.abort();
    assert.equal(await errorCode(client(spy.fetch).c.getProductByBarcode('3017624010701', { signal: pre.signal })), 'ABORTED');
    assert.equal(spy.calls.length, 0);
  });
});

describe('OpenFoodFactsClient: configuración', () => {
  const base = { appName: 'TestApp', appVersion: '0.0.1', contact: 'https://example.test/contact' };

  it('exige un User-Agent identificable y seguro (sin valores por defecto)', () => {
    assert.throws(() => new OpenFoodFactsClient({ ...base, contact: '' }), (e: unknown) => e instanceof OffError && e.code === 'CONFIG');
    assert.throws(() => new OpenFoodFactsClient({ ...base, appName: 'App\r\nX-Evil: 1' }), (e: unknown) => e instanceof OffError && e.code === 'CONFIG');
    assert.throws(() => new OpenFoodFactsClient({ ...base, language: 'Español' }), (e: unknown) => e instanceof OffError && e.code === 'CONFIG');
    assert.equal(new OpenFoodFactsClient(base).userAgent, 'TestApp/0.0.1 (https://example.test/contact)');
  });

  it('normaliza baseUrl con barra final', async () => {
    const { fetch, calls } = scripted([res(200, PRODUCT_OK)]);
    await client(fetch, { baseUrl: 'https://mirror.example.test//' }).c.getProductByBarcode('3017624010701');
    assert.match(calls[0]?.url ?? '', /^https:\/\/mirror\.example\.test\/api\/v2\/product\//);
  });
});

// ───────────────────────────── mapeo de datos sucios ─────────────────────────────

describe('mapProduct: datos de OFF incompletos o sospechosos', () => {
  const map = (product: Record<string, unknown>) => mapProduct(product, '3017624010701', 'es');
  const codes = (product: Record<string, unknown>) => map(product).warnings.map((w) => w.code);

  it('sin kcal usa kJ / 4.184; sin sodio usa sal / 2.5', () => {
    // 10 P + 20 C + 10 G → 210 kcal por Atwater vs 239 declaradas: dentro de la tolerancia, sin aviso de desajuste.
    const p = map({ product_name: 'X', nutriments: { energy_100g: 1000, salt_100g: 1, proteins_100g: 10, carbohydrates_100g: 20, fat_100g: 10 } });
    assert.equal(p.nutrients.energyKcal, 239.01);
    assert.equal(p.nutrients.sodiumMg, 400);
    assert.deepEqual(codes({ product_name: 'X', nutriments: { energy_100g: 1000, salt_100g: 1, proteins_100g: 10, carbohydrates_100g: 20, fat_100g: 10 } }), ['ENERGY_FROM_KJ', 'SODIUM_FROM_SALT']);
    assert.ok(codes({ product_name: 'X', nutriments: { energy_100g: 1000 } }).includes('ENERGY_FROM_KJ'));
    assert.ok(codes({ product_name: 'X', nutriments: { salt_100g: 1 } }).includes('SODIUM_FROM_SALT'));
  });

  it('acepta números como texto, incluida la coma decimal', () => {
    const p = map({ product_name: 'X', nutriments: { 'energy-kcal_100g': '250', proteins_100g: '12,5', carbohydrates_100g: '30', fat_100g: '8' } });
    assert.equal(p.nutrients.proteinG, 12.5);
    assert.equal(p.isComplete, true);
  });

  it('descarta valores imposibles y marca el producto como incompleto', () => {
    const p = map({ product_name: 'X', nutriments: { 'energy-kcal_100g': 300, proteins_100g: -4, carbohydrates_100g: 30, fat_100g: 8 } });
    assert.equal(p.nutrients.proteinG, null);
    assert.equal(p.isComplete, false);
    assert.deepEqual(p.warnings, [{ code: 'VALUE_OUT_OF_RANGE', field: 'proteinG' }]);
    assert.equal(map({ product_name: 'X', nutriments: { 'energy-kcal_100g': 5000 } }).nutrients.energyKcal, null);
  });

  it('sin nutriments: todo null e incompleto; sin nombre: "Producto <código>"', () => {
    const p = map({});
    assert.deepEqual(p.nutrients, { energyKcal: null, proteinG: null, carbsG: null, fatG: null, fiberG: null, sodiumMg: null });
    assert.equal(p.isComplete, false);
    assert.equal(p.name, 'Producto 3017624010701');
    assert.ok(p.warnings.some((w) => w.code === 'MISSING_NAME'));
  });

  it('macros que suman más de 100 g por 100 g → dudoso, no se puede guardar solo', () => {
    const p = map({ product_name: 'X', nutriments: { 'energy-kcal_100g': 500, proteins_100g: 50, carbohydrates_100g: 50, fat_100g: 30 } });
    assert.equal(p.isComplete, false);
    assert.ok(p.warnings.some((w) => w.code === 'MACROS_EXCEED_100G'));
  });

  it('avisa (sin bloquear) cuando kcal y macros no cuadran', () => {
    const p = map({ product_name: 'X', nutriments: { 'energy-kcal_100g': 400, proteins_100g: 10, carbohydrates_100g: 10, fat_100g: 10 } });
    assert.equal(p.isComplete, true);
    assert.ok(p.warnings.some((w) => w.code === 'ENERGY_MISMATCH'));
  });
});

// ───────────────────── integración con la base y con la porción ─────────────────────

describe('de Open Food Facts a SQLite', () => {
  const adapt = (raw: DatabaseSync): SqlExecutor => ({
    execAsync: async (sql) => {
      raw.exec(sql);
    },
    getFirstAsync: async <T>(sql: string) => (raw.prepare(sql).get() as T | undefined) ?? null,
  });

  it('un producto completo se guarda en foods y se reutiliza por barcode; el duplicado se rechaza', async () => {
    const raw = new DatabaseSync(':memory:');
    await runMigrations(adapt(raw));

    const { fetch } = scripted([res(200, PRODUCT_OK)]);
    const found = await client(fetch).c.getProductByBarcode('3017624010701');
    assert.equal(found.status, 'found');
    if (found.status !== 'found') return;
    const record = toFoodRecord(found.product, 1_762_300_000_000);
    assert.ok(record !== null);

    const insert = () =>
      raw
        .prepare(
          `INSERT INTO foods (barcode, name, brand, source, kcal_100g, protein_100g, carbs_100g, fat_100g,
                              fiber_100g, sodium_mg_100g, serving_g, serving_label, off_fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(record.barcode, record.name, record.brand, record.source, record.kcal100g, record.protein100g, record.carbs100g, record.fat100g, record.fiber100g, record.sodiumMg100g, record.servingG, record.servingLabel, record.offFetchedAt);
    insert();
    assert.throws(insert, /UNIQUE constraint failed/i);

    const row = raw.prepare('SELECT name, kcal_100g, sodium_mg_100g, source FROM foods WHERE barcode = ?').get('3017624010701');
    assert.deepEqual({ ...row }, { name: 'Crema de avellanas', kcal_100g: 539, sodium_mg_100g: 42.8, source: 'open_food_facts' });
  });

  it('un producto incompleto no genera registro (la UI pide los datos faltantes)', () => {
    assert.equal(toFoodRecord(mapProduct({ product_name: 'X', nutriments: {} }, '3017624010701', 'es'), 0), null);
  });
});

describe('selector de porción por gramaje', () => {
  const per100g = { energyKcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9, fiberG: null, sodiumMg: 42.8 };

  it('recalcula por gramos, mantiene los desconocidos en null y valida la entrada', () => {
    assert.deepEqual(scaleNutrients(per100g, 15), { energyKcal: 80.9, proteinG: 0.9, carbsG: 8.6, fatG: 4.6, fiberG: null, sodiumMg: 6.4 });
    assert.equal(scaleNutrients(per100g, 0).energyKcal, 0);
    assert.equal(scaleNutrients(per100g, 250).energyKcal, 1347.5);
    assert.throws(() => scaleNutrients(per100g, -1), RangeError);
    assert.throws(() => scaleNutrients(per100g, Number.NaN), RangeError);
    assert.equal(isComplete(per100g), true);
    assert.equal(isComplete({ ...per100g, fatG: null }), false);
  });
});
