import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { createLogger } from '../src/logger.ts';
import { AuthService } from '../src/auth/authService.ts';

/**
 * Login lockout is kept in the database: it survives a restart (a new service instance on the same database), counts
 * unknown usernames as well, clears on a successful sign-in, and can be released by an administrator.
 */
const PASSWORD = 'Kestrel-7-Orbit-mapping';
const WINDOW = 400;
let dir: string;
let db: Db;
const log = createLogger('error', false);
const service = () => new AuthService(db, 12, { lockout: { threshold: 3, windowMs: WINDOW } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-lockout-'));
  db = await openDb(undefined, join(dir, 'db'));
  await migrate(db, log);
  await service().create('analyst', 'Analyst', 'analyst', PASSWORD);
}, 120_000);

afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('login lockout', () => {
  it('locks a username after the threshold of consecutive failures, even for the right password', async () => {
    const a = service();
    for (let i = 0; i < 3; i++) expect(await a.login('analyst', 'wrong-wrong-wrong', null)).toBeNull();
    expect(await a.login('analyst', PASSWORD, null)).toEqual({ locked: true });
  });

  it('keeps the lock across a restart, because it is stored in the database', async () => {
    const restarted = service();
    expect(await restarted.login('analyst', PASSWORD, null)).toEqual({ locked: true });
  });

  it('releases the lock when the window runs out, and starts counting again', async () => {
    await new Promise((r) => setTimeout(r, WINDOW + 50));
    const a = service();
    expect(await a.login('analyst', 'wrong-wrong-wrong', null)).toBeNull();
    const ok = await a.login('analyst', PASSWORD, null);
    expect(ok).toMatchObject({ user: { username: 'analyst' } });
  });

  it('counts failures for an unknown username too, so the lock does not reveal which names exist', async () => {
    const a = service();
    for (let i = 0; i < 3; i++) expect(await a.login('nobody-here', 'x', null)).toBeNull();
    expect(await a.login('nobody-here', 'x', null)).toEqual({ locked: true });
  });

  it('clears the failure count on a successful sign-in, so earlier failures do not add up', async () => {
    const a = service();
    expect(await a.login('analyst', 'wrong-wrong-wrong', null)).toBeNull();
    expect(await a.login('analyst', 'wrong-wrong-wrong', null)).toBeNull();
    expect(await a.login('analyst', PASSWORD, null)).toMatchObject({ user: { username: 'analyst' } });
    expect(await a.login('analyst', 'wrong-wrong-wrong', null)).toBeNull();
    expect(await a.login('analyst', 'wrong-wrong-wrong', null)).toBeNull();
    expect(await a.login('analyst', PASSWORD, null)).toMatchObject({ user: { username: 'analyst' } });
  });

  it('can be released by an administrator before the window runs out', async () => {
    const a = service();
    for (let i = 0; i < 3; i++) await a.login('analyst', 'wrong-wrong-wrong', null);
    expect(await a.login('analyst', PASSWORD, null)).toEqual({ locked: true });
    await a.clearLockout('analyst');
    expect(await a.login('analyst', PASSWORD, null)).toMatchObject({ user: { username: 'analyst' } });
  });
});
