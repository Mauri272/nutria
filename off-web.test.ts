import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { OpenFoodFactsClient, OffError, type FetchLike } from '../src/services/openFoodFacts';

const product = (code: string, name: string) => ({
  code,
  product_name: name,
  nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5, carbohydrates_100g: 10, fat_100g: 3, fiber_100g: 1 },
});

function mk(body: unknown, seen: { url?: string; headers?: Record<string, string> }, status = 200): FetchLike {
  return async (url, init) => {
    seen.url = url;
    seen.headers = init.headers;
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => body };
  };
}

test('modo navegador: sin User-Agent y sin exigir contacto', async () => {
  const seen: { url?: string; headers?: Record<string, string> } = {};
  const c = new OpenFoodFactsClient({ appName: '', appVersion: '', contact: '', sendUserAgent: false, fetch: mk({ status: 0 }, seen) });
  assert.equal(c.userAgent, null);
  const r = await c.getProductByBarcode('3017620422003');
  assert.equal(r.status, 'not_found');
  assert.deepEqual(Object.keys(seen.headers ?? {}), ['Accept']); // solo cabeceras "simples": sin preflight CORS
});

test('por defecto sigue exigiendo contacto', () => {
  assert.throws(() => new OpenFoodFactsClient({ appName: 'A', appVersion: '1', contact: '' }), OffError);
});

test('búsqueda por texto: mapea, descarta códigos inválidos y codifica la consulta', async () => {
  const seen: { url?: string } = {};
  const c = new OpenFoodFactsClient({
    appName: '', appVersion: '', contact: '', sendUserAgent: false,
    fetch: mk({ products: [product('3017620422003', 'Crema'), product('1234567890123', 'Código malo'), 'x'] }, seen),
  });
  const res = await c.searchProducts('crema de avellanas');
  assert.equal(res.length, 1);
  assert.equal(res[0]?.name, 'Crema');
  assert.match(seen.url ?? '', /search_terms=crema%20de%20avellanas/);
  assert.match(seen.url ?? '', /page_size=20/);
});

test('búsqueda: consulta corta, respuesta rara y vacía', async () => {
  const mkc = (body: unknown) => new OpenFoodFactsClient({ appName: '', appVersion: '', contact: '', sendUserAgent: false, fetch: mk(body, {}) });
  await assert.rejects(() => mkc({}).searchProducts('a'), OffError);
  await assert.rejects(() => mkc([]).searchProducts('arroz'), (e: unknown) => e instanceof OffError && e.code === 'BAD_RESPONSE');
  assert.deepEqual(await mkc({ products: [] }).searchProducts('arroz'), []);
  assert.deepEqual(await mkc({}).searchProducts('arroz'), []);
});
