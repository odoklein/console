import { readdir, readFile } from 'node:fs/promises';
import type { Sql } from './db.ts';
import { log } from './log.ts';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const LOCK_ID = 727_101; // any constant shared by every instance: concurrent boots wait for each other

/** Applies pending migrations/*.sql in filename order, all in one transaction. Returns the files applied. */
export async function migrate(sql: Sql): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID}::bigint)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(await readFile(new URL(file, MIGRATIONS_DIR), 'utf8')).simple();
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      applied.push(file);
      log.info('migration.applied', { file });
    }
    return applied;
  });
}
