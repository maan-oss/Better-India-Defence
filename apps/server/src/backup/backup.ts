import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Db, Queryable } from '../db/client.ts';
import { migrate } from '../db/migrate.ts';
import { AuditLog, verifyChain, type AuditRecord } from '../audit/audit.ts';
import type { Logger } from '../logger.ts';

/**
 * Backup and restore of the whole installation: every table of the database as JSON lines, and the object store.
 * A backup is a directory with a manifest of the SHA-256 and size of every file in it. Restore refuses a backup whose
 * files do not match the manifest, refuses an audit chain that does not verify, and refuses a target that is not
 * empty. The database is read in one transaction, so the snapshot is consistent; objects are copied after it, so
 * every object a row refers to is already on disk when the copy starts.
 */
export const BACKUP_FORMAT = 'strata-backup/1';
export const BACKUP_MANIFEST = 'manifest.json';
/** Rows written per INSERT on restore. */
const CHUNK = 500;

export interface BackupFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  engine: Db['engine'];
  migrations: string[];
  tables: Record<string, number>;
  /** The audit chain at the moment of the backup; restore checks the chain it loads ends here. */
  auditHead: { seq: number; hash: string } | null;
  files: BackupFile[];
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** Names the whole row. A table may have a column called x, so the alias must not be a plausible column name. */
const ROW_ALIAS = '"__strata_row"';

async function digestFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    h.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: h.digest('hex'), bytes };
}

async function walk(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const abs = join(dir, name);
    if ((await stat(abs)).isDirectory()) out.push(...(await walk(root, abs)));
    else out.push(relative(root, abs).split(sep).join('/'));
  }
  return out;
}

/** Ordinary tables of the public schema: extension-owned tables (PostGIS reference data) are not ours to copy. */
async function listTables(q: Queryable): Promise<string[]> {
  return (
    await q.query<{ table_name: string }>(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      ORDER BY c.relname`)
  ).rows.map((r) => r.table_name);
}

/** Tables in an order where every table comes after the tables it refers to. Self-references are allowed. */
async function restoreOrder(q: Queryable, tables: string[]): Promise<string[]> {
  const fks = (
    await q.query<{ child: string; parent: string }>(`
      SELECT DISTINCT c.relname AS child, p.relname AS parent
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_class p ON p.oid = k.confrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE k.contype = 'f' AND n.nspname = 'public'`)
  ).rows;
  const pending = new Map(tables.map((t) => [t, new Set(fks.filter((f) => f.child === t && f.parent !== t && tables.includes(f.parent)).map((f) => f.parent))]));
  const order: string[] = [];
  while (pending.size) {
    const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([t]) => t).sort();
    if (ready.length === 0) throw new Error(`foreign keys form a cycle among: ${[...pending.keys()].join(', ')}`);
    for (const t of ready) {
      order.push(t);
      pending.delete(t);
      for (const deps of pending.values()) deps.delete(t);
    }
  }
  return order;
}

/** Writes a backup of the database and the object store into `outDir`. */
export async function createBackup(db: Db, dataDir: string, outDir: string): Promise<BackupManifest> {
  if (await access(outDir).then(() => true, () => false)) {
    if ((await readdir(outDir)).length > 0) throw new Error(`the backup directory is not empty: ${outDir}`);
  }
  await mkdir(join(outDir, 'db'), { recursive: true });
  const snapshot = await db.transaction(async (q) => {
    const tables = await listTables(q);
    // The row as text, exactly as PostgreSQL prints the JSON, so every engine writes the same bytes.
    const data = new Map<string, string[]>();
    for (const t of tables) {
      data.set(t, (await q.query<{ row: string }>(`SELECT to_jsonb(${ROW_ALIAS})::text AS row FROM ${ident(t)} AS ${ROW_ALIAS}`)).rows.map((r) => r.row));
    }
    const migrations = (await q.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
    const head = (await q.query<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1')).rows[0] ?? null;
    return { data, migrations, head };
  });
  const tables: Record<string, number> = {};
  for (const [t, rows] of snapshot.data) {
    tables[t] = rows.length;
    await writeFile(join(outDir, 'db', `${t}.jsonl`), rows.map((r) => `${r}\n`).join(''));
  }
  // Objects after the snapshot: every object a row names has been written before its row could be read here.
  const objects = join(dataDir, 'objects');
  if (await access(objects).then(() => true, () => false)) await cp(objects, join(outDir, 'objects'), { recursive: true });
  const files: BackupFile[] = [];
  for (const path of (await walk(outDir)).filter((p) => p !== BACKUP_MANIFEST)) files.push({ path, ...(await digestFile(join(outDir, path))) });
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    engine: db.engine,
    migrations: snapshot.migrations,
    tables,
    auditHead: snapshot.head ? { seq: Number(snapshot.head.seq), hash: snapshot.head.hash } : null,
    files,
  };
  await writeFile(join(outDir, BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Every way a backup on disk differs from its manifest, and every file the manifest does not list. */
export async function verifyBackup(dir: string): Promise<{ manifest: BackupManifest; problems: string[] }> {
  const manifest = JSON.parse(await readFile(join(dir, BACKUP_MANIFEST), 'utf8')) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT || !Array.isArray(manifest.files)) throw new Error('not a Strata backup');
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const f of manifest.files) {
    if (f.path.startsWith('/') || f.path.split('/').includes('..')) {
      problems.push(`${f.path}: path escapes the backup`);
      continue;
    }
    listed.add(f.path);
    const abs = join(dir, f.path);
    if (!(await access(abs).then(() => true, () => false))) {
      problems.push(`${f.path}: missing`);
      continue;
    }
    const got = await digestFile(abs);
    if (got.sha256 !== f.sha256 || got.bytes !== f.bytes) problems.push(`${f.path}: content differs from the backup manifest`);
  }
  for (const path of await walk(dir)) if (path !== BACKUP_MANIFEST && !listed.has(path)) problems.push(`${path}: not in the backup manifest`);
  return { manifest, problems };
}

/** The target must hold nothing: a restore fills an empty installation, it never merges into one. */
async function assertEmpty(q: Queryable, tables: string[], dataDir: string): Promise<void> {
  for (const t of tables) {
    if (t === 'schema_migrations') continue;
    const n = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${ident(t)}`)).rows[0]?.n ?? 0;
    if (n > 0) throw new Error(`the target database is not empty: ${t} has ${n} row(s); restore into a new data directory`);
  }
  if (await access(join(dataDir, 'objects')).then(() => true, () => false)) {
    if ((await readdir(join(dataDir, 'objects'))).length > 0) throw new Error('the target object store is not empty; restore into a new data directory');
  }
}

export interface RestoreSummary {
  tables: number;
  rows: number;
  objects: number;
  auditRecords: number;
}

/**
 * Loads a verified backup into an empty database and data directory. The audit chain in the backup must verify and
 * end at the head recorded in the manifest, checked before any row is written. Afterwards the live chain is verified
 * again. A failure after rows were written leaves them in place: discard that data directory and restore again.
 */
export async function restoreBackup(dir: string, db: Db, dataDir: string, log: Logger): Promise<RestoreSummary> {
  const { manifest, problems } = await verifyBackup(dir);
  if (problems.length) throw new Error(`backup failed verification (${problems.length}): ${problems.slice(0, 5).join('; ')}`);
  const audit = (await readFile(join(dir, 'db', 'audit_events.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord);
  const chain = verifyChain(audit);
  if (!chain.ok) throw new Error(`the backup's audit chain does not verify at record ${chain.brokenAt}`);
  if ((manifest.auditHead?.hash ?? null) !== chain.head) throw new Error('the backup audit chain does not end at the recorded head');

  await migrate(db, log);
  const tables = await listTables(db);
  const backupTables = Object.keys(manifest.tables);
  const schema = (await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
  if (JSON.stringify(schema) !== JSON.stringify(manifest.migrations)) {
    throw new Error(`the backup was made with migrations [${manifest.migrations.join(', ')}] and this build has [${schema.join(', ')}]`);
  }
  await assertEmpty(db, tables, dataDir);

  const order = (await restoreOrder(db, backupTables)).filter((t) => t !== 'schema_migrations');
  let rows = 0;
  await db.transaction(async (q) => {
    for (const t of order) {
      const lines = (await readFile(join(dir, 'db', `${t}.jsonl`), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      for (let i = 0; i < lines.length; i += CHUNK) {
        const chunk = lines.slice(i, i + CHUNK);
        await q.query(`INSERT INTO ${ident(t)} SELECT * FROM jsonb_populate_recordset(NULL::${ident(t)}, $1::jsonb)`, [JSON.stringify(chunk)]).catch((e: Error) => {
          throw new Error(`restoring ${t} (rows ${i + 1}-${i + chunk.length}): ${e.message}; first row ${JSON.stringify(chunk[0]).slice(0, 200)}`);
        });
      }
      rows += lines.length;
      // Identity and serial columns continue from the highest restored value.
      const columns = (await q.query<{ attname: string }>(`SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, [ident(t)])).rows;
      for (const { attname } of columns) {
        const seq = (await q.query<{ seq: string | null }>(`SELECT pg_get_serial_sequence($1, $2) AS seq`, [ident(t), attname])).rows[0]?.seq;
        if (!seq) continue;
        const max = (await q.query<{ max: number | null }>(`SELECT max(${ident(attname)})::bigint AS max FROM ${ident(t)}`)).rows[0]?.max;
        if (max !== null && max !== undefined) await q.query('SELECT setval($1::regclass, $2::bigint, true)', [seq, Number(max)]);
      }
    }
  });

  let objects = 0;
  const src = join(dir, 'objects');
  if (await access(src).then(() => true, () => false)) {
    await cp(src, join(dataDir, 'objects'), { recursive: true });
    objects = (await walk(src)).length;
  }
  const live = await new AuditLog(db).verify();
  if (!live.ok) throw new Error(`the restored audit chain does not verify at record ${live.brokenAt}; discard this data directory`);
  log.info({ tables: order.length, rows, objects, auditRecords: chain.checked }, 'backup restored');
  return { tables: order.length, rows, objects, auditRecords: chain.checked };
}
