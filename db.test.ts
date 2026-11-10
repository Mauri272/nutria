import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  runMigrations,
  getSchemaVersion,
  MigrationError,
  type Migration,
  type SqlExecutor,
} from '../src/db/migrate';

// Adaptador mínimo: node:sqlite (SQLite real) detrás de la interfaz que usa el ejecutor de migraciones.
function adapt(raw: DatabaseSync): SqlExecutor {
  return {
    execAsync: async (sql) => {
      raw.exec(sql);
    },
    getFirstAsync: async <T>(sql: string) => (raw.prepare(sql).get() as T | undefined) ?? null,
  };
}

async function freshDb(): Promise<DatabaseSync> {
  const raw = new DatabaseSync(':memory:');
  await runMigrations(adapt(raw));
  return raw;
}

// node:sqlite devuelve filas con prototipo nulo; se copian a objetos planos para poder usar deepEqual estricto.
function all<T>(raw: DatabaseSync, sql: string): T[] {
  return raw.prepare(sql).all().map((row) => ({ ...row }) as T);
}

function one<T>(raw: DatabaseSync, sql: string): T {
  const row = raw.prepare(sql).get();
  assert.ok(row !== undefined, `sin filas para: ${sql}`);
  return { ...row } as T;
}

function run(raw: DatabaseSync, sql: string): number {
  return Number(raw.prepare(sql).run().lastInsertRowid);
}

const CONSTRAINT = /constraint failed/i;

function addUser(raw: DatabaseSync): number {
  return run(raw, "INSERT INTO users (sex, birth_date, height_cm) VALUES ('male', '1995-04-12', 176)");
}

function addFood(raw: DatabaseSync, name: string, kcal: number, p: number, c: number, f: number, fiber: number | null = null): number {
  const fi = fiber === null ? 'NULL' : String(fiber);
  return run(
    raw,
    `INSERT INTO foods (name, kcal_100g, protein_100g, carbs_100g, fat_100g, fiber_100g) VALUES ('${name}', ${kcal}, ${p}, ${c}, ${f}, ${fi})`,
  );
}

function addLog(raw: DatabaseSync, userId: number, date = '2026-11-05'): number {
  return run(raw, `INSERT INTO daily_logs (user_id, log_date, target_kcal, target_protein_g) VALUES (${userId}, '${date}', 2600, 160)`);
}

function slotId(raw: DatabaseSync, userId: number, code: string): number {
  return one<{ id: number }>(raw, `SELECT id FROM meal_slots WHERE user_id = ${userId} AND code = '${code}'`).id;
}

describe('migraciones', () => {
  it('aplica el esquema, fija user_version = 1 y es idempotente', async () => {
    const raw = new DatabaseSync(':memory:');
    const db = adapt(raw);
    assert.deepEqual(await runMigrations(db), { from: 0, to: 1 });
    assert.equal(await getSchemaVersion(db), 1);
    assert.deepEqual(await runMigrations(db), { from: 1, to: 1 });
  });

  it('crea las seis tablas pedidas más franjas, entradas y vistas', async () => {
    const raw = await freshDb();
    const names = all<{ name: string }>(raw, "SELECT name FROM sqlite_master WHERE type IN ('table','view')").map((r) => r.name);
    for (const t of ['users', 'daily_logs', 'foods', 'recipes', 'recipe_ingredients', 'body_measurements', 'meal_slots', 'meal_entries']) {
      assert.ok(names.includes(t), `falta la tabla ${t}`);
    }
    for (const v of ['v_daily_totals', 'v_slot_totals', 'v_recipe_nutrition']) {
      assert.ok(names.includes(v), `falta la vista ${v}`);
    }
  });

  it('si una migración falla, hace rollback completo y no avanza user_version', async () => {
    const raw = new DatabaseSync(':memory:');
    const db = adapt(raw);
    const good: Migration = { version: 1, name: 'ok', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY);' };
    const bad: Migration = {
      version: 2,
      name: 'rota',
      sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY); CREATE TABLE a (id INTEGER PRIMARY KEY);',
    };
    await assert.rejects(() => runMigrations(db, [good, bad]), (e: unknown) => e instanceof MigrationError && e.version === 2);
    assert.equal(await getSchemaVersion(db), 1);
    const b = all<{ name: string }>(raw, "SELECT name FROM sqlite_master WHERE name = 'b'");
    assert.equal(b.length, 0, 'la tabla b debió revertirse');
  });

  it('rechaza migraciones no consecutivas y bases más nuevas que la app', async () => {
    const raw = new DatabaseSync(':memory:');
    const db = adapt(raw);
    await assert.rejects(() => runMigrations(db, [{ version: 2, name: 'salto', sql: 'SELECT 1;' }]), /consecutivas/);
    raw.exec('PRAGMA user_version = 99');
    await assert.rejects(() => runMigrations(db), /más nueva que la app/);
  });
});

describe('integridad: users, daily_logs, body_measurements', () => {
  it('un usuario nuevo recibe las 6 franjas por defecto (trigger)', async () => {
    const raw = await freshDb();
    const uid = addUser(raw);
    const slots = all<{ code: string; label: string }>(raw, `SELECT code, label FROM meal_slots WHERE user_id = ${uid} ORDER BY sort_order`);
    assert.deepEqual(slots.map((s) => s.code), ['breakfast', 'lunch', 'tea', 'dinner', 'snacks', 'workout']);
    assert.equal(slots[2]?.label, 'Once / Merienda');
  });

  it('rechaza sexo inválido, fecha imposible, fecha basura y estatura fuera de rango', async () => {
    const raw = await freshDb();
    const ins = (sex: string, birth: string, h: number) => () =>
      run(raw, `INSERT INTO users (sex, birth_date, height_cm) VALUES ('${sex}', '${birth}', ${h})`);
    assert.throws(ins('other', '1995-04-12', 176), CONSTRAINT);
    assert.throws(ins('male', '1995-02-30', 176), CONSTRAINT);
    assert.throws(ins('male', 'ayer', 176), CONSTRAINT);
    assert.throws(ins('male', '1995-04-12', 60), CONSTRAINT);
    assert.doesNotThrow(ins('female', '1992-02-29', 165));
  });

  it('daily_logs: una fila por usuario y día, y validación de rangos', async () => {
    const raw = await freshDb();
    const uid = addUser(raw);
    addLog(raw, uid);
    assert.throws(() => addLog(raw, uid), /UNIQUE constraint failed/i);
    assert.throws(() => run(raw, `INSERT INTO daily_logs (user_id, log_date, steps) VALUES (${uid}, '2026-11-06', -5)`), CONSTRAINT);
    assert.throws(() => run(raw, `INSERT INTO daily_logs (user_id, log_date, weight_kg) VALUES (${uid}, '2026-11-07', 12)`), CONSTRAINT);
  });

  it('body_measurements: exige al menos un valor y una fila por día', async () => {
    const raw = await freshDb();
    const uid = addUser(raw);
    assert.throws(() => run(raw, `INSERT INTO body_measurements (user_id, measured_on) VALUES (${uid}, '2026-11-05')`), CONSTRAINT);
    assert.doesNotThrow(() => run(raw, `INSERT INTO body_measurements (user_id, measured_on, waist_cm) VALUES (${uid}, '2026-11-05', 82.5)`));
    assert.throws(() => run(raw, `INSERT INTO body_measurements (user_id, measured_on, chest_cm) VALUES (${uid}, '2026-11-05', 100)`), /UNIQUE constraint failed/i);
  });
});

describe('integridad: foods', () => {
  it('rechaza valores imposibles por 100 g', async () => {
    const raw = await freshDb();
    assert.throws(() => addFood(raw, 'x', -1, 0, 0, 0), CONSTRAINT);
    assert.throws(() => addFood(raw, 'x', 400, 60, 60, 30), CONSTRAINT); // macros suman > 101 g
    assert.doesNotThrow(() => addFood(raw, 'Aceite', 884, 0, 0, 100));
  });

  it('barcode: solo dígitos (8–14), único cuando existe, y varios NULL permitidos', async () => {
    const raw = await freshDb();
    const ins = (code: string) => () =>
      run(raw, `INSERT INTO foods (barcode, name, kcal_100g, protein_100g, carbs_100g, fat_100g) VALUES (${code}, 'p', 100, 1, 1, 1)`);
    assert.doesNotThrow(ins("'7802800512345'"));
    assert.throws(ins("'7802800512345'"), /UNIQUE constraint failed/i);
    assert.throws(ins("'ABC12345'"), CONSTRAINT);
    assert.throws(ins("'123'"), CONSTRAINT);
    assert.doesNotThrow(ins('NULL'));
    assert.doesNotThrow(ins('NULL'));
  });

  it('UPSERT por barcode actualiza el alimento existente en vez de duplicarlo', async () => {
    const raw = await freshDb();
    const upsert = (name: string, kcal: number) =>
      raw
        .prepare(
          `INSERT INTO foods (barcode, name, kcal_100g, protein_100g, carbs_100g, fat_100g)
           VALUES ('7802800512345', ?, ?, 1, 1, 1)
           ON CONFLICT(barcode) DO UPDATE SET name = excluded.name, kcal_100g = excluded.kcal_100g`,
        )
        .run(name, kcal);
    upsert('Viejo', 100);
    upsert('Nuevo', 120);
    const rows = all<{ name: string; kcal_100g: number }>(raw, "SELECT name, kcal_100g FROM foods WHERE barcode = '7802800512345'");
    assert.deepEqual(rows, [{ name: 'Nuevo', kcal_100g: 120 }]);
  });
});

describe('integridad referencial', () => {
  it('con foreign_keys activo, no deja insertar entradas huérfanas', async () => {
    const raw = await freshDb();
    assert.throws(() => run(raw, "INSERT INTO meal_entries (daily_log_id, meal_slot_id, name, quantity_g) VALUES (999, 999, 'x', 100)"), /FOREIGN KEY constraint failed/i);
  });

  it('una entrada no puede referir alimento y receta a la vez', async () => {
    const raw = await freshDb();
    const uid = addUser(raw);
    const log = addLog(raw, uid);
    const food = addFood(raw, 'Arroz', 130, 2.7, 28, 0.3);
    const recipe = run(raw, `INSERT INTO recipes (user_id, name) VALUES (${uid}, 'Bowl')`);
    assert.throws(
      () => run(raw, `INSERT INTO meal_entries (daily_log_id, meal_slot_id, food_id, recipe_id, name, quantity_g) VALUES (${log}, ${slotId(raw, uid, 'lunch')}, ${food}, ${recipe}, 'x', 100)`),
      CONSTRAINT,
    );
  });

  it('bloquea el borrado de un alimento usado en una receta', async () => {
    const raw = await freshDb();
    const uid = addUser(raw);
    const food = addFood(raw, 'Avena', 370, 13, 60, 7, 10);
    const recipe = run(raw, `INSERT INTO recipes (user_id, name) VALUES (${uid}, 'Porridge')`);
    run(raw, `INSERT INTO recipe_ingredients (recipe_id, food_id, grams) VALUES (${recipe}, ${food}, 100)`);
    assert.throws(() => run(raw, `DELETE FROM foods WHERE id = ${food}`), /FOREIGN KEY constraint failed/i);
  });

  it('SET NULL: borrar un alimento conserva el historial (nombre y macros congelados)', async () => {
    const raw = await freshDb();
    const uid = addUser(raw);
    const log = addLog(raw, uid);
    const food = addFood(raw, 'Yogur', 60, 4, 6, 2);
    run(raw, `INSERT INTO meal_entries (daily_log_id, meal_slot_id, food_id, name, quantity_g, kcal, protein_g) VALUES (${log}, ${slotId(raw, uid, 'tea')}, ${food}, 'Yogur', 200, 120, 8)`);
    run(raw, `DELETE FROM foods WHERE id = ${food}`);
    const e = one<{ food_id: number | null; name: string; kcal: number }>(raw, 'SELECT food_id, name, kcal FROM meal_entries');
    assert.equal(e.food_id, null);
    assert.equal(e.name, 'Yogur');
    assert.equal(e.kcal, 120);
  });

  it('bloquea borrar una franja con historial, pero borrar el usuario limpia todo en cascada', async () => {
    const raw = await freshDb();
    const uid = addUser(raw);
    const log = addLog(raw, uid);
    const lunch = slotId(raw, uid, 'lunch');
    run(raw, `INSERT INTO meal_entries (daily_log_id, meal_slot_id, name, quantity_g, kcal) VALUES (${log}, ${lunch}, 'Pollo', 150, 250)`);
    run(raw, `INSERT INTO body_measurements (user_id, measured_on, waist_cm) VALUES (${uid}, '2026-11-05', 80)`);
    assert.throws(() => run(raw, `DELETE FROM meal_slots WHERE id = ${lunch}`), /FOREIGN KEY constraint failed/i);
    run(raw, `DELETE FROM users WHERE id = ${uid}`);
    for (const t of ['daily_logs', 'meal_entries', 'meal_slots', 'body_measurements', 'recipes']) {
      assert.equal(one<{ n: number }>(raw, `SELECT COUNT(*) AS n FROM ${t}`).n, 0, `${t} debió quedar vacía`);
    }
  });
});

describe('vistas', () => {
  it('v_recipe_nutrition: totales, por 100 g y por porción', async () => {
    const raw = await freshDb();
    const uid = addUser(raw);
    const oats = addFood(raw, 'Avena', 370, 13, 60, 7, 10);
    const milk = addFood(raw, 'Leche', 50, 3.4, 5, 1.8);
    const recipe = run(raw, `INSERT INTO recipes (user_id, name, servings) VALUES (${uid}, 'Porridge', 2)`);
    run(raw, `INSERT INTO recipe_ingredients (recipe_id, food_id, grams) VALUES (${recipe}, ${oats}, 200), (${recipe}, ${milk}, 300)`);
    const r = one<Record<string, number>>(raw, `SELECT * FROM v_recipe_nutrition WHERE recipe_id = ${recipe}`);
    assert.equal(r['total_weight_g'], 500);
    assert.equal(r['kcal'], 890); // 370·2 + 50·3
    assert.equal(r['kcal_100g'], 178);
    assert.equal(r['kcal_per_serving'], 445);
    assert.equal(r['grams_per_serving'], 250);
    assert.ok(Math.abs((r['protein_100g'] ?? 0) - 7.24) < 1e-9); // (13·2 + 3.4·3) / 5
    assert.equal(r['fiber_100g'], 4); // la leche no declara fibra → cuenta 0
  });

  it('v_recipe_nutrition: el peso cocido (final_weight_g) cambia el valor por 100 g', async () => {
    const raw = await freshDb();
    const uid = addUser(raw);
    const oats = addFood(raw, 'Avena', 370, 13, 60, 7);
    const recipe = run(raw, `INSERT INTO recipes (user_id, name, final_weight_g) VALUES (${uid}, 'Avena cocida', 400)`);
    run(raw, `INSERT INTO recipe_ingredients (recipe_id, food_id, grams) VALUES (${recipe}, ${oats}, 100)`);
    const r = one<Record<string, number>>(raw, `SELECT kcal, kcal_100g FROM v_recipe_nutrition WHERE recipe_id = ${recipe}`);
    assert.equal(r['kcal'], 370);
    assert.equal(r['kcal_100g'], 92.5);
  });

  it('v_recipe_nutrition: receta sin ingredientes no revienta (por 100 g = NULL)', async () => {
    const raw = await freshDb();
    const uid = addUser(raw);
    const recipe = run(raw, `INSERT INTO recipes (user_id, name) VALUES (${uid}, 'Vacía')`);
    const r = one<{ kcal: number; kcal_100g: number | null }>(raw, `SELECT kcal, kcal_100g FROM v_recipe_nutrition WHERE recipe_id = ${recipe}`);
    assert.equal(r.kcal, 0);
    assert.equal(r.kcal_100g, null);
  });

  it('v_daily_totals y v_slot_totals suman snapshots; un día vacío da ceros con sus objetivos', async () => {
    const raw = await freshDb();
    const uid = addUser(raw);
    const log = addLog(raw, uid, '2026-11-05');
    const empty = addLog(raw, uid, '2026-11-06');
    const bk = slotId(raw, uid, 'breakfast');
    const ln = slotId(raw, uid, 'lunch');
    const ins = (slot: number, name: string, kcal: number, p: number) =>
      run(raw, `INSERT INTO meal_entries (daily_log_id, meal_slot_id, name, quantity_g, kcal, protein_g) VALUES (${log}, ${slot}, '${name}', 100, ${kcal}, ${p})`);
    ins(bk, 'Huevos', 300, 25);
    ins(bk, 'Pan', 200, 6);
    ins(ln, 'Pollo', 450, 50);

    const d = one<{ kcal: number; protein_g: number; target_kcal: number }>(raw, `SELECT kcal, protein_g, target_kcal FROM v_daily_totals WHERE daily_log_id = ${log}`);
    assert.deepEqual(d, { kcal: 950, protein_g: 81, target_kcal: 2600 });

    const e = one<{ kcal: number; protein_g: number; target_protein_g: number }>(raw, `SELECT kcal, protein_g, target_protein_g FROM v_daily_totals WHERE daily_log_id = ${empty}`);
    assert.deepEqual(e, { kcal: 0, protein_g: 0, target_protein_g: 160 });

    const slots = all<{ slot_code: string; kcal: number }>(raw, `SELECT slot_code, kcal FROM v_slot_totals WHERE daily_log_id = ${log} ORDER BY sort_order`);
    assert.deepEqual(slots, [
      { slot_code: 'breakfast', kcal: 500 },
      { slot_code: 'lunch', kcal: 450 },
    ]);
  });
});
