import { MIGRATION_001_INIT } from './migrations/001_init';

/**
 * Superficie mínima de base de datos que necesita el ejecutor de migraciones.
 * `SQLiteDatabase` de expo-sqlite la satisface estructuralmente (execAsync / getFirstAsync),
 * y en tests se implementa con `node:sqlite`. Así el núcleo no depende de Expo.
 */
export interface SqlExecutor {
  execAsync(sql: string): Promise<void>;
  getFirstAsync<T>(sql: string): Promise<T | null>;
}

export interface Migration {
  /** Entero consecutivo desde 1. Se guarda en PRAGMA user_version. */
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'init', sql: MIGRATION_001_INIT }];

/** Se aplican en CADA conexión. foreign_keys no persiste en el archivo y es no-op dentro de una transacción. */
export const CONNECTION_PRAGMAS = 'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;';

export class MigrationError extends Error {
  readonly version: number;
  constructor(version: number, name: string, cause: unknown) {
    super(`Falló la migración ${version} (${name}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationError';
    this.version = version;
  }
}

export async function getSchemaVersion(db: SqlExecutor): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

function assertSequential(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Las migraciones deben ser consecutivas desde 1: se esperaba ${i + 1} y llegó ${m.version}.`);
    }
  });
}

/**
 * Lleva la base al esquema más reciente. Cada migración corre en su propia transacción
 * junto con la actualización de user_version: o se aplica completa o no se aplica nada.
 * Ejecutar ANTES de montar la UI (p. ej. en `onInit` de <SQLiteProvider>).
 */
export async function runMigrations(
  db: SqlExecutor,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ from: number; to: number }> {
  assertSequential(migrations);
  await db.execAsync(CONNECTION_PRAGMAS);

  const from = await getSchemaVersion(db);
  const latest = migrations.length;
  if (from > latest) {
    throw new Error(`La base está en la versión ${from}, más nueva que la app (${latest}). Actualiza la app.`);
  }

  let current = from;
  for (const m of migrations) {
    if (m.version <= current) continue;
    await db.execAsync('BEGIN IMMEDIATE');
    try {
      await db.execAsync(m.sql);
      await db.execAsync(`PRAGMA user_version = ${m.version}`);
      await db.execAsync('COMMIT');
    } catch (err) {
      await db.execAsync('ROLLBACK').catch(() => undefined);
      throw new MigrationError(m.version, m.name, err);
    }
    current = m.version;
  }
  return { from, to: current };
}
