import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { openDb, type Db } from '../src/db/client.ts';
import { AuditLog } from '../src/audit/audit.ts';
import { createBackup, restoreBackup, type BackupManifest } from '../src/backup/backup.ts';

/**
 * Backup and restore on PostgreSQL, not the embedded engine. Runs only when STRATA_TEST_DATABASE_URL names a PostgreSQL
 * server the test may create databases on, for example postgres://postgres@127.0.0.1:5433/postgres; it creates two
 * databases with unique names and drops them afterwards. Without the variable the suite is skipped, so the default
 * run needs no database server.
 */
const admin = process.env.STRATA_TEST_DATABASE_URL;
const log = createLogger('error', false);
const stem = `strata_bk_${randomBytes(4).toString('hex')}`;
const sourceName = `${stem}_src`;
const targetName = `${stem}_dst`;
const urlFor = (database: string) => {
  const u = new URL(admin!);
  u.pathname = `/${database}`;
  return u.toString();
};
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const object = Buffer.from('frame bytes for the PostgreSQL restore test');

let root: string;
let manifest: BackupManifest;
let outDir: string;
let targetDb: Db | undefined;
let pgAdmin: Client | undefined;

beforeAll(async () => {
  if (!admin) return;
  const pg = (await import('pg')).default;
  pgAdmin = new pg.Client({ connectionString: admin });
  await pgAdmin.connect();
  await pgAdmin.query(`CREATE DATABASE "${sourceName}"`);
  await pgAdmin.query(`CREATE DATABASE "${targetName}"`);
  root = mkdtempSync(join(tmpdir(), 'strata-pgbackup-'));
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urlFor(sourceName),
    DATA_DIR: join(root, 'source'),
    STRATA_SERVICE_TOKEN: 'test-service-token-0123456789',
    SIM_URL: 'http://127.0.0.1:9',
    LOG_LEVEL: 'error',
  });
  const source = new Platform(cfg, log);
  await source.start();
  for (let i = 0; i < 4; i++) await source.audit.append({ actor: 'tester', role: 'administrator', action: 'test.event', target: `item-${i}`, detail: { i } });
  await source.store.put('evidence', object);
  outDir = join(root, 'backup');
  manifest = await createBackup(source.db, cfg.dataDir, outDir);
  await source.stop();
}, 180_000);

afterAll(async () => {
  if (!admin) return;
  await targetDb?.close().catch(() => undefined);
  if (pgAdmin) {
    for (const name of [sourceName, targetName]) await pgAdmin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    await pgAdmin.end().catch(() => undefined);
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!admin)('backup and restore on PostgreSQL', () => {
  it('restores into an empty PostgreSQL database with the same rows, the same audit chain and the same objects', async () => {
    expect(manifest.format).toBe('strata-backup/1');
    const targetDir = join(root, 'restored');
    targetDb = await openDb(urlFor(targetName), targetDir);
    expect(targetDb.engine).toBe('postgres');
    const summary = await restoreBackup(outDir, targetDb, targetDir, log);
    expect(summary.auditRecords).toBe(manifest.tables.audit_events);
    for (const [table, count] of Object.entries(manifest.tables)) {
      if (table === 'schema_migrations') continue;
      const n = (await targetDb.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0]!.n;
      expect(n, table).toBe(count);
    }
    expect(await new AuditLog(targetDb).verify()).toMatchObject({ ok: true, brokenAt: null });
    const anchors = readFileSync(join(targetDir, 'audit-anchors.log'), 'utf8').split('\n').filter(Boolean);
    expect(anchors).toHaveLength(manifest.tables.audit_events ?? -1);
    const restored = manifest.files.find((f) => f.path.startsWith('objects/evidence/'))!;
    expect(sha(readFileSync(join(targetDir, 'objects', restored.path.replace(/^objects\//, ''))))).toBe(restored.sha256);
  }, 120_000);
});
