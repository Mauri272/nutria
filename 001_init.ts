/**
 * Migración 001 — esquema inicial.
 *
 * Convenciones:
 *  - Fechas de calendario (log_date, measured_on, birth_date): TEXT 'YYYY-MM-DD' en HORA LOCAL del usuario.
 *    El CHECK `date(x) IS x` rechaza formatos raros y fechas imposibles (2026-02-30). Se usa IS (no =)
 *    porque date('basura') es NULL y un CHECK que da NULL pasaría.
 *  - Instantes (created_at, updated_at, logged_at, *_at): INTEGER epoch en milisegundos UTC.
 *    El DEFAULT tiene precisión de segundos; el código de la app debe escribir Date.now().
 *  - `foods` guarda nutrientes SIEMPRE por 100 g.
 *  - `meal_entries` guarda una FOTO (snapshot) de lo consumido: editar o borrar un alimento no reescribe el historial.
 *  - `daily_logs.target_*` congela los objetivos vigentes ese día (para medir adherencia histórica).
 *  - Compatible con SQLite ≥ 3.24 (UPSERT). Sin STRICT ni columnas generadas, a propósito.
 *  - Requiere PRAGMA foreign_keys = ON en cada conexión (ver CONNECTION_PRAGMAS en migrate.ts).
 *  - Para "bloquear borrados" se usa NO ACTION (el default), NO "ON DELETE RESTRICT": RESTRICT se evalúa al
 *    instante y puede fallar según el orden de las cascadas (p. ej. al borrar un usuario, si SQLite elimina
 *    meal_slots antes que daily_logs → meal_entries). NO ACTION se evalúa al final de la sentencia.
 */
export const MIGRATION_001_INIT = `
CREATE TABLE users (
  id               INTEGER PRIMARY KEY,
  display_name     TEXT    NOT NULL DEFAULT '',
  sex              TEXT    NOT NULL CHECK (sex IN ('male','female')),
  birth_date       TEXT    NOT NULL CHECK (date(birth_date) IS birth_date),
  height_cm        REAL    NOT NULL CHECK (height_cm BETWEEN 120 AND 230),
  experience       TEXT    NOT NULL DEFAULT 'intermediate' CHECK (experience IN ('beginner','intermediate','advanced')),
  goal             TEXT    NOT NULL DEFAULT 'maintain'     CHECK (goal IN ('gain','lose','maintain')),
  horizon          TEXT    NOT NULL DEFAULT 'medium'       CHECK (horizon IN ('short','medium','long')),
  target_weight_kg REAL             CHECK (target_weight_kg IS NULL OR target_weight_kg BETWEEN 30 AND 300),
  activity_mode    TEXT    NOT NULL DEFAULT 'pal'          CHECK (activity_mode IN ('pal','steps')),
  pal              REAL    NOT NULL DEFAULT 1.375          CHECK (pal BETWEEN 1.2 AND 1.9),
  fat_pct          REAL    NOT NULL DEFAULT 0.25           CHECK (fat_pct BETWEEN 0.20 AND 0.30),
  created_at       INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at       INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- Alimentos (globales). Incluye los escaneados desde Open Food Facts y los creados a mano.
CREATE TABLE foods (
  id              INTEGER PRIMARY KEY,
  barcode         TEXT    CHECK (barcode IS NULL OR (length(barcode) BETWEEN 8 AND 14 AND barcode NOT GLOB '*[^0-9]*')),
  name            TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  brand           TEXT,
  source          TEXT    NOT NULL DEFAULT 'user' CHECK (source IN ('open_food_facts','user')),
  kcal_100g       REAL    NOT NULL CHECK (kcal_100g    BETWEEN 0 AND 950),
  protein_100g    REAL    NOT NULL CHECK (protein_100g BETWEEN 0 AND 100),
  carbs_100g      REAL    NOT NULL CHECK (carbs_100g   BETWEEN 0 AND 100),
  fat_100g        REAL    NOT NULL CHECK (fat_100g     BETWEEN 0 AND 100),
  fiber_100g      REAL             CHECK (fiber_100g IS NULL OR fiber_100g BETWEEN 0 AND 100),
  sodium_mg_100g  REAL             CHECK (sodium_mg_100g IS NULL OR sodium_mg_100g BETWEEN 0 AND 40000),
  serving_g       REAL             CHECK (serving_g IS NULL OR serving_g > 0),
  serving_label   TEXT,
  is_favorite     INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1)),
  is_archived     INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  off_fetched_at  INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  CHECK (protein_100g + carbs_100g + fat_100g <= 101)
);
-- UNIQUE simple (no parcial): en SQLite los NULL son distintos entre sí, así que varios alimentos manuales
-- sin código conviven, y el UPSERT puede usar ON CONFLICT(barcode). Con un índice parcial ese destino falla.
CREATE UNIQUE INDEX ux_foods_barcode ON foods(barcode);
CREATE INDEX ix_foods_name ON foods(name COLLATE NOCASE);

CREATE TABLE recipes (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  servings        REAL    NOT NULL DEFAULT 1 CHECK (servings > 0),
  final_weight_g  REAL             CHECK (final_weight_g IS NULL OR final_weight_g > 0),
  notes           TEXT,
  is_archived     INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  created_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX ix_recipes_user ON recipes(user_id);

-- Un alimento usado en una receta no se puede borrar (NO ACTION): se archiva con foods.is_archived.
CREATE TABLE recipe_ingredients (
  id          INTEGER PRIMARY KEY,
  recipe_id   INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  food_id     INTEGER NOT NULL REFERENCES foods(id),
  grams       REAL    NOT NULL CHECK (grams > 0 AND grams <= 100000),
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
CREATE INDEX ix_recipe_ingredients_food   ON recipe_ingredients(food_id);

-- Una fila por usuario y día: peso, pasos/sueño (Health Connect) y objetivos vigentes ese día.
-- El sueño se asigna al día en que TERMINA la sesión (fecha de despertar).
CREATE TABLE daily_logs (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_date          TEXT    NOT NULL CHECK (date(log_date) IS log_date),
  weight_kg         REAL    CHECK (weight_kg IS NULL OR weight_kg BETWEEN 30 AND 300),
  steps             INTEGER CHECK (steps IS NULL OR steps BETWEEN 0 AND 100000),
  sleep_minutes     INTEGER CHECK (sleep_minutes IS NULL OR sleep_minutes BETWEEN 0 AND 1440),
  sleep_deep_min    INTEGER CHECK (sleep_deep_min  IS NULL OR sleep_deep_min  >= 0),
  sleep_rem_min     INTEGER CHECK (sleep_rem_min   IS NULL OR sleep_rem_min   >= 0),
  sleep_light_min   INTEGER CHECK (sleep_light_min IS NULL OR sleep_light_min >= 0),
  sleep_awake_min   INTEGER CHECK (sleep_awake_min IS NULL OR sleep_awake_min >= 0),
  health_synced_at  INTEGER,
  target_kcal       INTEGER CHECK (target_kcal IS NULL OR target_kcal > 0),
  target_protein_g  INTEGER CHECK (target_protein_g IS NULL OR target_protein_g >= 0),
  target_carbs_g    INTEGER CHECK (target_carbs_g   IS NULL OR target_carbs_g   >= 0),
  target_fat_g      INTEGER CHECK (target_fat_g     IS NULL OR target_fat_g     >= 0),
  target_fiber_g    INTEGER CHECK (target_fiber_g   IS NULL OR target_fiber_g   >= 0),
  notes             TEXT,
  created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  UNIQUE (user_id, log_date)
);

-- División configurable del día. Se siembran 6 por defecto al crear el usuario (trigger de abajo).
CREATE TABLE meal_slots (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        TEXT    NOT NULL CHECK (length(trim(code)) > 0),
  label       TEXT    NOT NULL CHECK (length(trim(label)) > 0),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  UNIQUE (user_id, code)
);

CREATE TRIGGER trg_users_default_meal_slots AFTER INSERT ON users
BEGIN
  INSERT INTO meal_slots (user_id, code, label, sort_order) VALUES
    (NEW.id, 'breakfast', 'Desayuno',          1),
    (NEW.id, 'lunch',     'Almuerzo',          2),
    (NEW.id, 'tea',       'Once / Merienda',   3),
    (NEW.id, 'dinner',    'Cena',              4),
    (NEW.id, 'snacks',    'Snacks',            5),
    (NEW.id, 'workout',   'Pre / Post-Entreno', 6);
END;

-- Lo consumido. food_id / recipe_id pasan a NULL si el origen se borra; name + macros sobreviven (snapshot).
CREATE TABLE meal_entries (
  id            INTEGER PRIMARY KEY,
  daily_log_id  INTEGER NOT NULL REFERENCES daily_logs(id) ON DELETE CASCADE,
  meal_slot_id  INTEGER NOT NULL REFERENCES meal_slots(id),
  food_id       INTEGER          REFERENCES foods(id)      ON DELETE SET NULL,
  recipe_id     INTEGER          REFERENCES recipes(id)    ON DELETE SET NULL,
  name          TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  quantity_g    REAL    NOT NULL CHECK (quantity_g > 0 AND quantity_g <= 100000),
  kcal          REAL    NOT NULL DEFAULT 0 CHECK (kcal       >= 0),
  protein_g     REAL    NOT NULL DEFAULT 0 CHECK (protein_g  >= 0),
  carbs_g       REAL    NOT NULL DEFAULT 0 CHECK (carbs_g    >= 0),
  fat_g         REAL    NOT NULL DEFAULT 0 CHECK (fat_g      >= 0),
  fiber_g       REAL    NOT NULL DEFAULT 0 CHECK (fiber_g    >= 0),
  sodium_mg     REAL    NOT NULL DEFAULT 0 CHECK (sodium_mg  >= 0),
  logged_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  CHECK (food_id IS NULL OR recipe_id IS NULL)
);
CREATE INDEX ix_meal_entries_log    ON meal_entries(daily_log_id);
CREATE INDEX ix_meal_entries_slot   ON meal_entries(meal_slot_id);
CREATE INDEX ix_meal_entries_food   ON meal_entries(food_id);
CREATE INDEX ix_meal_entries_recipe ON meal_entries(recipe_id);

-- Medidas periódicas. Al menos un valor por fila. body_fat_pct alimenta Katch–McArdle.
CREATE TABLE body_measurements (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  measured_on   TEXT    NOT NULL CHECK (date(measured_on) IS measured_on),
  neck_cm       REAL CHECK (neck_cm       IS NULL OR neck_cm       BETWEEN 10 AND 100),
  shoulders_cm  REAL CHECK (shoulders_cm  IS NULL OR shoulders_cm  BETWEEN 60 AND 250),
  chest_cm      REAL CHECK (chest_cm      IS NULL OR chest_cm      BETWEEN 50 AND 250),
  waist_cm      REAL CHECK (waist_cm      IS NULL OR waist_cm      BETWEEN 40 AND 250),
  hips_cm       REAL CHECK (hips_cm       IS NULL OR hips_cm       BETWEEN 50 AND 250),
  biceps_cm     REAL CHECK (biceps_cm     IS NULL OR biceps_cm     BETWEEN 10 AND 100),
  thigh_cm      REAL CHECK (thigh_cm      IS NULL OR thigh_cm      BETWEEN 20 AND 150),
  body_fat_pct  REAL CHECK (body_fat_pct  IS NULL OR body_fat_pct  BETWEEN 3 AND 60),
  notes         TEXT,
  created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  UNIQUE (user_id, measured_on),
  CHECK (COALESCE(neck_cm, shoulders_cm, chest_cm, waist_cm, hips_cm, biceps_cm, thigh_cm, body_fat_pct) IS NOT NULL)
);

-- Totales del día: consumido (suma de snapshots) junto a los objetivos congelados de ese día.
CREATE VIEW v_daily_totals AS
SELECT dl.id AS daily_log_id, dl.user_id, dl.log_date,
       COALESCE(SUM(me.kcal), 0)      AS kcal,
       COALESCE(SUM(me.protein_g), 0) AS protein_g,
       COALESCE(SUM(me.carbs_g), 0)   AS carbs_g,
       COALESCE(SUM(me.fat_g), 0)     AS fat_g,
       COALESCE(SUM(me.fiber_g), 0)   AS fiber_g,
       COALESCE(SUM(me.sodium_mg), 0) AS sodium_mg,
       dl.target_kcal, dl.target_protein_g, dl.target_carbs_g, dl.target_fat_g, dl.target_fiber_g
FROM daily_logs dl
LEFT JOIN meal_entries me ON me.daily_log_id = dl.id
GROUP BY dl.id;

-- Totales por comida dentro de cada día.
CREATE VIEW v_slot_totals AS
SELECT me.daily_log_id, me.meal_slot_id, ms.code AS slot_code, ms.label AS slot_label, ms.sort_order,
       SUM(me.kcal) AS kcal, SUM(me.protein_g) AS protein_g, SUM(me.carbs_g) AS carbs_g,
       SUM(me.fat_g) AS fat_g, SUM(me.fiber_g) AS fiber_g
FROM meal_entries me
JOIN meal_slots ms ON ms.id = me.meal_slot_id
GROUP BY me.daily_log_id, me.meal_slot_id;

-- Nutrición de cada receta: totales, por 100 g del producto final y por porción.
-- total_weight_g = peso cocido (final_weight_g) o, si es NULL, la suma de los ingredientes.
CREATE VIEW v_recipe_nutrition AS
WITH totals AS (
  SELECT r.id AS recipe_id,
         r.servings AS servings,
         COALESCE(r.final_weight_g, SUM(ri.grams)) AS total_weight_g,
         COALESCE(SUM(f.kcal_100g    * ri.grams / 100.0), 0) AS kcal,
         COALESCE(SUM(f.protein_100g * ri.grams / 100.0), 0) AS protein_g,
         COALESCE(SUM(f.carbs_100g   * ri.grams / 100.0), 0) AS carbs_g,
         COALESCE(SUM(f.fat_100g     * ri.grams / 100.0), 0) AS fat_g,
         COALESCE(SUM(COALESCE(f.fiber_100g, 0)     * ri.grams / 100.0), 0) AS fiber_g,
         COALESCE(SUM(COALESCE(f.sodium_mg_100g, 0) * ri.grams / 100.0), 0) AS sodium_mg
  FROM recipes r
  LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
  LEFT JOIN foods f ON f.id = ri.food_id
  GROUP BY r.id
)
SELECT recipe_id, servings, total_weight_g, kcal, protein_g, carbs_g, fat_g, fiber_g, sodium_mg,
       kcal      * 100.0 / total_weight_g AS kcal_100g,
       protein_g * 100.0 / total_weight_g AS protein_100g,
       carbs_g   * 100.0 / total_weight_g AS carbs_100g,
       fat_g     * 100.0 / total_weight_g AS fat_100g,
       fiber_g   * 100.0 / total_weight_g AS fiber_100g,
       sodium_mg * 100.0 / total_weight_g AS sodium_mg_100g,
       total_weight_g / servings AS grams_per_serving,
       kcal      / servings AS kcal_per_serving,
       protein_g / servings AS protein_per_serving,
       carbs_g   / servings AS carbs_per_serving,
       fat_g     / servings AS fat_per_serving,
       fiber_g   / servings AS fiber_per_serving
FROM totals;
`;
