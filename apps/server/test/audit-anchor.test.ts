import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, type Db } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { createLogger } from '../src/logger.ts';
import { AuditLog } from '../src/audit/audit.ts';
import { AuditAnchor, verifyAnchors, type AnchorLine } from '../src/audit/anchor.ts';

/**
 * The audit head outside the database. The chain can be rewritten by someone with database access; the anchor file
 * is what shows it. These tests rewrite, truncate and delete through SQL (the append-only trigger is switched off for
 * that purpose, as an administrator with database access could do) and check that the anchors name the change.
 */
const log = createLogger('error', false);
let dir: string;
let db: Db;
let anchor: AuditAnchor;
let audit: AuditLog;

const check = async (key: Buffer | null = null) => {
  const a = new AuditAnchor(anchor.file, key);
  const records = (await db.query<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_events ORDER BY seq')).rows;
  return verifyAnchors(records, await a.read(), (l) => a.macMatches(l));
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-anchor-'));
  db = await openDb(undefined, join(dir, 'db'));
  await migrate(db, log);
  anchor = new AuditAnchor(join(dir, 'audit-anchors.log'), null);
  audit = new AuditLog(db, anchor);
  for (let i = 0; i < 4; i++) await audit.append({ actor: 'tester', role: 'administrator', action: 'test.event', target: `n${i}` });
}, 120_000);

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('anchor verification (pure)', () => {
  const recs = [
    { seq: 1, hash: 'a' },
    { seq: 2, hash: 'b' },
    { seq: 3, hash: 'c' },
  ];
  const line = (seq: number, hash: string): AnchorLine => ({ seq, hash, t: 1 });
  const yes = () => true;

  it('passes when every anchored record matches, and counts records after the last anchor as not yet anchored', () => {
    const r = verifyAnchors(recs, { lines: [line(1, 'a'), line(2, 'b')], malformed: [] }, yes);
    expect(r).toMatchObject({ ok: true, anchors: 2, lastSeq: 2, problems: [] });
  });

  it('names a rewritten record, a missing record, and an anchor past the end (records removed)', () => {
    expect(verifyAnchors(recs, { lines: [line(2, 'x')], malformed: [] }, yes).problems).toEqual(['anchored record 2 was rewritten']);
    expect(verifyAnchors(recs.filter((r) => r.seq !== 2), { lines: [line(2, 'b')], malformed: [] }, yes).problems).toEqual(['anchored record 2 is missing']);
    expect(verifyAnchors(recs.slice(0, 1), { lines: [line(1, 'a'), line(3, 'c')], malformed: [] }, yes).problems).toEqual([
      'anchor 3 is past the end of the chain (head 1): records were removed',
    ]);
  });

  it('refuses a line whose MAC does not verify, an out-of-order anchor and a malformed line', () => {
    expect(verifyAnchors(recs, { lines: [line(1, 'a')], malformed: [] }, () => false).problems).toEqual(['anchor 1: the MAC does not verify']);
    expect(verifyAnchors(recs, { lines: [line(2, 'b'), line(1, 'a')], malformed: [] }, yes).problems).toEqual(['anchor 1: not after anchor 2']);
    expect(verifyAnchors(recs, { lines: [], malformed: [5] }, yes).problems).toEqual(['anchor line 5 does not parse']);
  });
});

describe('anchor file', () => {
  it('records each committed audit record, one line each, after the row exists', async () => {
    const lines = (await anchor.read()).lines;
    const rows = (await db.query<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_events ORDER BY seq')).rows;
    expect(lines.map((l) => [l.seq, l.hash])).toEqual(rows.map((r) => [r.seq, r.hash]));
    expect(await check()).toMatchObject({ ok: true, problems: [] });
  });

  it('is written with an HMAC when a key is configured, and a line without the right MAC is refused', async () => {
    const key = randomBytes(32);
    const keyed = new AuditAnchor(join(dir, 'keyed.log'), key);
    await keyed.record(1, 'a'.repeat(64), 5);
    const [line] = (await keyed.read()).lines;
    expect(line!.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(keyed.macMatches(line!)).toBe(true);
    expect(keyed.macMatches({ ...line!, hash: 'b'.repeat(64) })).toBe(false);
    expect(new AuditAnchor(join(dir, 'keyed.log'), randomBytes(32)).macMatches(line!)).toBe(false);
  });

  it('names a chain rewritten below the anchored head, even when every hash in the chain is recomputed', async () => {
    // A rewrite of record 2 that the chain itself cannot show: the row changes and its hash is replaced by another.
    const original = (await db.query<{ hash: string }>('SELECT hash FROM audit_events WHERE seq = 2')).rows[0]!.hash;
    await db.exec('ALTER TABLE audit_events DISABLE TRIGGER USER');
    try {
      await db.query('UPDATE audit_events SET hash = $1 WHERE seq = 2', ['f'.repeat(64)]);
      const r = await check();
      expect(r.ok).toBe(false);
      expect(r.problems).toEqual(['anchored record 2 was rewritten']);
    } finally {
      await db.query('UPDATE audit_events SET hash = $1 WHERE seq = 2', [original]);
      await db.exec('ALTER TABLE audit_events ENABLE TRIGGER USER');
    }
  });

  it('names a truncation: the last records deleted after they were anchored', async () => {
    const head = (await db.query<{ seq: number }>('SELECT max(seq)::int AS seq FROM audit_events')).rows[0]!.seq;
    await db.exec('CREATE TEMP TABLE saved_row AS SELECT * FROM audit_events WHERE seq = ' + head);
    await db.exec('ALTER TABLE audit_events DISABLE TRIGGER USER');
    try {
      await db.query('DELETE FROM audit_events WHERE seq = $1', [head]);
      const r = await check();
      expect(r.problems).toEqual([`anchor ${head} is past the end of the chain (head ${head - 1}): records were removed`]);
    } finally {
      await db.exec('INSERT INTO audit_events SELECT * FROM saved_row');
      await db.exec('ALTER TABLE audit_events ENABLE TRIGGER USER');
    }
  });

  it('reports a malformed anchor line instead of skipping it', async () => {
    const copy = join(dir, 'bad.log');
    writeFileSync(copy, `${readFileSync(anchor.file, 'utf8')}not json\n`);
    const records = (await db.query<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_events ORDER BY seq')).rows;
    const r = verifyAnchors(records, await new AuditAnchor(copy, null).read(), yes);
    expect(r.problems).toEqual(['anchor line 5 does not parse']);
  });
});

const yes = () => true;
