import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';

/**
 * The policy applies to passwords an administrator sets: in the user routes, and to the first administrator's
 * password from the environment. A refusal lists every reason. The sign-in for the administrator still works.
 */
const ADMIN_PASSWORD = 'Kestrel-7-Orbit-mapping';
let dir: string;
let platform: Platform;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-policy-'));
  const cfg = loadConfig({
    NODE_ENV: 'test',
    STRATA_MODE: 'operational',
    STRATA_MFA_REQUIRED: 'false',
    DATA_DIR: dir,
    STRATA_ADMIN_PASSWORD: ADMIN_PASSWORD,
    STRATA_SERVICE_TOKEN: 'test-service-token-0123456789',
    SIM_URL: 'http://127.0.0.1:9',
    LOG_LEVEL: 'error',
  });
  platform = new Platform(cfg, createLogger('error', false));
  await platform.start();
  app = await buildApp(platform);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: ADMIN_PASSWORD } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const create = (password: string, username = 'newanalyst') =>
  app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie }, payload: { username, displayName: 'New Analyst', role: 'analyst', password } });

describe('password policy', () => {
  it('refuses a common password for a new user and says why', async () => {
    const r = await create('password12345');
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'password does not meet the password policy', problems: ['is a common password or word'] });
  });

  it('refuses a password that contains the account name', async () => {
    const r = await create('Newanalyst-harbour-42', 'newanalyst');
    expect(r.statusCode).toBe(400);
    expect(r.json().problems).toContain('must not contain the account name');
  });

  it('accepts a password that meets the policy, and the new user can sign in', async () => {
    const r = await create('Corvid-Lantern-4471-harbour');
    expect(r.statusCode).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'newanalyst', password: 'Corvid-Lantern-4471-harbour' } });
    expect(login.statusCode).toBe(200);
  });

  it('applies the same rule when an administrator changes a password', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } })).json() as { id: string; username: string }[];
    const id = list.find((u) => u.username === 'newanalyst')!.id;
    const r = await app.inject({ method: 'PATCH', url: `/api/admin/users/${id}`, headers: { cookie }, payload: { password: 'administrator' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().problems).toContain('is a common password or word');
  });

  it('refuses a weak first-administrator password from the environment at start-up', async () => {
    const weak = mkdtempSync(join(tmpdir(), 'strata-policy-weak-'));
    const cfg = loadConfig({ NODE_ENV: 'test', STRATA_MODE: 'operational', DATA_DIR: weak, STRATA_ADMIN_PASSWORD: 'administrator123', SIM_URL: 'http://127.0.0.1:9', STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', LOG_LEVEL: 'error' });
    const p = new Platform(cfg, createLogger('error', false));
    await expect(p.start()).rejects.toThrow(/does not meet the password policy/);
    await p.stop().catch(() => undefined);
    rmSync(weak, { recursive: true, force: true });
  }, 120_000);
});
