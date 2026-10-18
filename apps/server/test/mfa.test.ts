import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { base32Decode, totp } from '@strata/domain';
import { AuthService } from '../src/auth/authService.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';

/**
 * Second factor for privileged roles. The operational install requires one: the administrator signs in, is held to the
 * enrolment routes until a code from the new secret is confirmed, then signs in with a code at every later sign-in.
 * A code is accepted once; a wrong code counts against the account; removing a factor forces a new enrolment.
 */
const PASSWORD = 'Kestrel-7-Orbit-mapping';
const KEY = randomBytes(32).toString('hex');
let clock = Date.now();
let dir: string;
let platform: Platform;
let app: FastifyInstance;
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0]!;
const signIn = (username = 'admin', password = PASSWORD) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-mfa-'));
  const cfg = loadConfig({
    NODE_ENV: 'test',
    STRATA_MODE: 'operational',
    DATA_DIR: dir,
    STORAGE_ENCRYPTION_KEY: KEY,
    STRATA_ADMIN_PASSWORD: PASSWORD,
    STRATA_SERVICE_TOKEN: 'test-service-token-0123456789',
    SIM_URL: 'http://127.0.0.1:9',
    LOG_LEVEL: 'error',
  });
  platform = new Platform(cfg, createLogger('error', false));
  await platform.start();
  // The same service, with a clock the test moves: a code is accepted once per 30-second step, so each use needs a new step.
  platform.auth = new AuthService(platform.db, 12, { mfa: { key: Buffer.from(KEY, 'hex'), required: true, issuer: 'Strata', clock: () => clock } });
  app = await buildApp(platform);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('second factor for privileged roles', () => {
  let secret: Uint8Array;
  const nextStep = () => {
    clock += 30_000;
    return clock;
  };

  it('holds a privileged account that has not enrolled to the enrolment routes only', async () => {
    const login = await signIn();
    expect(login.statusCode).toBe(200);
    expect(login.json().mfa).toBe('enrol');
    const cookie = cookieOf(login);
    const blocked = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ mfa: 'enrol' });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ user: { mfaPending: true }, secondFactor: { required: true, available: true, enabled: false } });
  });

  it('enrols: the new secret is returned once, and a code from it activates the factor', async () => {
    const login = await signIn();
    const cookie = cookieOf(login);
    const begun = await app.inject({ method: 'POST', url: '/api/auth/mfa/enrol', headers: { cookie } });
    expect(begun.statusCode).toBe(200);
    const { secret: base32, uri } = begun.json() as { secret: string; uri: string };
    expect(uri).toMatch(/^otpauth:\/\/totp\/Strata(%3A|:)admin\?secret=[A-Z2-7]+&issuer=Strata/);
    secret = base32Decode(base32);
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/mfa/enrol/confirm', headers: { cookie }, payload: { code: '000000' } });
    expect(wrong.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/mfa/enrol/confirm', headers: { cookie }, payload: { code: totp(secret, clock) } });
    expect(ok.statusCode).toBe(200);
    const admin = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } });
    expect(admin.statusCode).toBe(200);
  });

  it('asks for a code at sign-in: the password alone gives a challenge and no session', async () => {
    const r = await signIn();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ mfa: 'required' });
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.json()).not.toHaveProperty('token');
  });

  it('refuses a wrong code, and the challenge is then spent', async () => {
    const { challenge } = (await signIn()).json() as { challenge: string };
    const bad = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge, code: '123456' } });
    expect(bad.statusCode).toBe(401);
    const again = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge, code: totp(secret, nextStep()) } });
    expect(again.statusCode).toBe(401);
  });

  it('accepts the right code once: a second use of the same code, even in a new sign-in, is refused', async () => {
    const code = totp(secret, nextStep());
    const { challenge } = (await signIn()).json() as { challenge: string };
    const ok = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge, code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ mfa: 'ok', user: { username: 'admin' } });
    expect(String(ok.headers['set-cookie'])).toContain('strata_session=');
    const { challenge: second } = (await signIn()).json() as { challenge: string };
    const replay = await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge: second, code } });
    expect(replay.statusCode).toBe(401);
  });

  it('removes a factor on an administrator\'s request, which ends the account\'s sessions and forces a new enrolment', async () => {
    const { challenge } = (await signIn()).json() as { challenge: string };
    const cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { challenge, code: totp(secret, nextStep()) } }));
    const removed = await app.inject({ method: 'DELETE', url: '/api/admin/users/admin/mfa', headers: { cookie } });
    expect(removed.statusCode).toBe(200);
    const after = await signIn();
    expect(after.json()).toMatchObject({ mfa: 'enrol' });
  });
});

describe('an installation without a storage key', () => {
  it('cannot enrol a second factor, and says why', async () => {
    const other = mkdtempSync(join(tmpdir(), 'strata-mfa-nokey-'));
    const cfg = loadConfig({ NODE_ENV: 'test', STRATA_MODE: 'operational', DATA_DIR: other, STRATA_ADMIN_PASSWORD: PASSWORD, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
    const p = new Platform(cfg, createLogger('error', false));
    await p.start();
    const a = await buildApp(p);
    try {
      const login = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PASSWORD } });
      const r = await a.inject({ method: 'POST', url: '/api/auth/mfa/enrol', headers: { cookie: cookieOf(login) } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatch(/STORAGE_ENCRYPTION_KEY/);
    } finally {
      await a.close();
      await p.stop();
      rmSync(other, { recursive: true, force: true });
    }
  }, 120_000);
});
