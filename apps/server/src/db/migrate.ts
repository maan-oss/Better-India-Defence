import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.ts';
import type { Logger } from '../logger.ts';

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, 'migrations'), join(here, 'db', 'migrations'), join(here, '..', 'src', 'db', 'migrations')]) if (existsSync(c)) return c;
  throw new Error('migrations directory not found');
}

/** Forward-only, versioned SQL migrations. Files marked "@optional" are skipped if they fail (e.g. no PostGIS). */
export async function migrate(db: Db, log: Logger): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at bigint NOT NULL, applied boolean NOT NULL)');
  const done = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    const optional = sql.includes('@optional');
    try {
      await db.transaction(async (q) => {
        await q.exec(sql);
        await q.query('INSERT INTO schema_migrations (version, applied_at, applied) VALUES ($1, $2, true)', [f, Date.now()]);
      });
      applied.push(f);
      log.info({ migration: f }, 'migration applied');
    } catch (e) {
      if (!optional) throw new Error(`migration ${f} failed: ${e instanceof Error ? e.message : String(e)}`);
      await db.query('INSERT INTO schema_migrations (version, applied_at, applied) VALUES ($1, $2, false)', [f, Date.now()]);
      log.warn({ migration: f, reason: e instanceof Error ? e.message : String(e) }, 'optional migration skipped');
    }
  }
  return applied;
}
