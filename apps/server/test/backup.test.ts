import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { openDb, type Db } from '../src/db/client.ts';
import { AuditLog } from '../src/audit/audit.ts';
import { createBackup, restoreBackup, verifyBackup, type BackupManifest } from '../src/backup/backup.ts';
import { createHash } from 'node:crypto';

/**
 * Backup and restore: a backup is restored byte-for-byte into an empty installation, and it is refused when a file
 * changed, when a file was added, when the audit chain was rewritten (even with a recomputed manifest), or when the
 * target already holds data.
 */
const log = createLogger('error', false);
let root: string;
let source: Platform;
let outDir: string;
let manifest: BackupManifest;
const object = Buffer.from('frame bytes for the restore test');
const opened: Db[] = [];

const fresh = (name: string) => join(root, name);
const open = async (dir: string) => {
  const db = await openDb(undefined, dir);
  opened.push(db);
  return db;
};
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'strata-backup-'));
  const cfg = loadConfig({ NODE_ENV: 'test', DATA_DIR: fresh('source'), STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
  source = new Platform(cfg, log);
  await source.start();
  for (let i = 0; i < 4; i++) await source.audit.append({ actor: 'tester', role: 'administrator', action: 'test.event', target: `item-${i}`, detail: { i, nested: { b: 2, a: 1 } } });
  await source.store.put('evidence', object);
  outDir = fresh('backup');
  manifest = await createBackup(source.db, cfg.dataDir, outDir);
  await source.stop();
}, 120_000);

afterAll(async () => {
  for (const db of opened) await db.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe('backup', () => {
  it('writes a manifest that lists every file, with digests, and records the audit head', async () => {
    expect(manifest.format).toBe('strata-backup/1');
    expect(manifest.tables.audit_events).toBeGreaterThanOrEqual(4);
    expect(manifest.auditHead?.hash).toMatch(/^[0-9a-f]{64}$/);
    const check = await verifyBackup(outDir);
    expect(check.problems).toEqual([]);
    expect(check.manifest.files.some((f) => f.path.startsWith('objects/evidence/'))).toBe(true);
  });

  it('restores into an empty installation with the same rows, the same audit chain and the same objects', async () => {
    const target = fresh('restored');
    const db = await open(target);
    const summary = await restoreBackup(outDir, db, target, log);
    expect(summary.auditRecords).toBe(manifest.tables.audit_events);
    for (const [table, count] of Object.entries(manifest.tables)) {
      if (table === 'schema_migrations') continue;
      const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0]!.n;
      expect(n, table).toBe(count);
    }
    expect(await new AuditLog(db).verify()).toMatchObject({ ok: true, brokenAt: null });
    const restoredObject = manifest.files.find((f) => f.path.startsWith('objects/evidence/'))!;
    expect(sha(readFileSync(join(target, 'objects', restoredObject.path.replace(/^objects\//, ''))))).toBe(restoredObject.sha256);
    // A restored sequence continues after the highest restored audit number.
    await new AuditLog(db).append({ actor: 'after', role: 'administrator', action: 'test.after-restore' });
    expect(await new AuditLog(db).verify()).toMatchObject({ ok: true });
  });

  it('refuses to restore into a target that already holds data', async () => {
    const db = await open(fresh('restored'));
    await expect(restoreBackup(outDir, db, fresh('restored'), log)).rejects.toThrow(/not empty/);
  });

  it('refuses a backup whose file changed after it was written', async () => {
    const copy = fresh('tampered-content');
    cpSync(outDir, copy, { recursive: true });
    writeFileSync(join(copy, 'db', 'audit_events.jsonl'), readFileSync(join(copy, 'db', 'audit_events.jsonl'), 'utf8') + ' ');
    const { problems } = await verifyBackup(copy);
    expect(problems).toContain('db/audit_events.jsonl: content differs from the backup manifest');
    await expect(restoreBackup(copy, await open(fresh('t1')), fresh('t1'), log)).rejects.toThrow(/failed verification/);
  });

  it('refuses a file the manifest does not list', async () => {
    const copy = fresh('tampered-extra');
    cpSync(outDir, copy, { recursive: true });
    writeFileSync(join(copy, 'db', 'extra.jsonl'), '{}\n');
    const { problems } = await verifyBackup(copy);
    expect(problems).toContain('db/extra.jsonl: not in the backup manifest');
  });

  it('refuses a rewritten audit chain even when the manifest is recomputed to match', async () => {
    const copy = fresh('rewritten');
    cpSync(outDir, copy, { recursive: true });
    const file = join(copy, 'db', 'audit_events.jsonl');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const target = lines.find((r) => r.action === 'test.event');
    target.detail = { i: 99, nested: { b: 2, a: 1 } };
    writeFileSync(file, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const m = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8')) as BackupManifest;
    const body = readFileSync(file);
    m.files = m.files.map((f) => (f.path === 'db/audit_events.jsonl' ? { ...f, sha256: sha(body), bytes: body.length } : f));
    writeFileSync(join(copy, 'manifest.json'), JSON.stringify(m, null, 2));
    expect((await verifyBackup(copy)).problems).toEqual([]);
    await expect(restoreBackup(copy, await open(fresh('t2')), fresh('t2'), log)).rejects.toThrow(/audit chain does not verify/);
  });
});
