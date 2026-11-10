/**
 * Genera docs/schema.sql a partir de las migraciones (la fuente de verdad es src/db/migrations/*.ts).
 * Uso: npm run schema:sql   (ejecutar desde la raíz del proyecto)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS } from '../src/db/migrate';

const header = [
  '-- GENERADO por `npm run schema:sql` desde src/db/migrations/*. No editar a mano.',
  '-- Requiere SQLite >= 3.24. Activar PRAGMA foreign_keys = ON en cada conexión.',
  '',
  '',
].join('\n');

const body = MIGRATIONS.map((m) => `-- ══ Migración ${m.version}: ${m.name} ══\n${m.sql.trim()}\n`).join('\n');

const outDir = join(process.cwd(), 'docs');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'schema.sql'), header + body, 'utf8');
console.log(`docs/schema.sql escrito (${MIGRATIONS.length} migración/es).`);
