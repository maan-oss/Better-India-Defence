import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Database abstraction over two real PostgreSQL engines:
 *  - an external PostgreSQL/PostGIS server (DATABASE_URL), used for deployments and docker-compose;
 *  - embedded PGlite (PostgreSQL compiled to WASM) when DATABASE_URL is unset, so the product runs
 *    offline with zero setup. Same SQL, same migrations.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Execute a multi-statement script without parameters. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly engine: 'postgres' | 'pglite';
  transaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(databaseUrl: string | undefined, dataDir: string): Promise<Db> {
  if (databaseUrl) {
    const pg = await import('pg');
    const Pool = pg.default.Pool;
    pg.default.types.setTypeParser(20, (v: string) => Number(v)); // int8 → number (epoch ms fits in 2^53)
    pg.default.types.setTypeParser(1700, (v: string) => Number(v));
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    await pool.query('select 1');
    return {
      engine: 'postgres',
      query: async <T>(sql: string, params?: unknown[]) => {
        const r = await pool.query(sql, params as unknown[]);
        return { rows: r.rows as T[] };
      },
      transaction: async <T>(fn: (q: Queryable) => Promise<T>) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({
            query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params as unknown[])).rows as R[] }),
            exec: async (sql: string) => {
              await client.query(sql);
            },
          });
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
      exec: async (sql: string) => {
        await pool.query(sql);
      },
      close: () => pool.end(),
    };
  }
  const { PGlite, types } = await import('@electric-sql/pglite');
  const dir = join(dataDir, 'pglite');
  mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir, {
    parsers: { [types.INT8]: (v: string) => Number(v), [types.NUMERIC]: (v: string) => Number(v) },
  });
  let chain: Promise<unknown> = Promise.resolve();
  // PGlite is single-connection: serialise transactions so concurrent requests cannot interleave inside one.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    engine: 'pglite',
    query: <T>(sql: string, params?: unknown[]) => serial(async () => ({ rows: (await db.query<T>(sql, params)).rows })),
    exec: (sql: string) =>
      serial(async () => {
        await db.exec(sql);
      }),
    transaction: <T>(fn: (q: Queryable) => Promise<T>) =>
      serial(() =>
        db.transaction(async (tx) =>
          fn({
            query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await tx.query<R>(sql, params)).rows }),
            exec: async (sql: string) => {
              await tx.exec(sql);
            },
          }),
        ),
      ),
    close: () => db.close(),
  };
}

/** Build a multi-row INSERT for `rows` (array of value arrays). Splits to respect the 65k parameter limit. */
export function chunkedValues(rows: unknown[][], casts: string[] = []): { sql: string; params: unknown[] }[] {
  if (!rows.length) return [];
  const width = rows[0]!.length;
  const perChunk = Math.max(1, Math.floor(30000 / width));
  const out: { sql: string; params: unknown[] }[] = [];
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const params: unknown[] = [];
    const tuples = chunk.map((r) => {
      const ph = r.map((v, j) => {
        params.push(v);
        return `$${params.length}${casts[j] ? `::${casts[j]}` : ''}`;
      });
      return `(${ph.join(',')})`;
    });
    out.push({ sql: tuples.join(','), params });
  }
  return out;
}
