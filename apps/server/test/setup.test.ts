import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreDemoSite } from '@strata/domain';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';

/**
 * Operational mode (the default outside tests): no demo users or content, a one-time setup code on first start,
 * the first administrator created through the setup API, and nothing simulated.
 */
const dir = mkdtempSync(join(tmpdir(), 'strata-setup-'));

describe('operational first run', () => {
  const env = { NODE_ENV: 'test', STRATA_MODE: 'operational', DATA_DIR: dir, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' };
  let p: Platform;

  afterAll(async () => {
    await p?.stop();
    restoreDemoSite();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty: no demo accounts, a setup code on disk, nothing simulated', async () => {
    const cfg = loadConfig(env);
    expect(cfg.STRATA_MODE).toBe('operational');
    expect(cfg.STRATA_DEMO_USERS).toBe('false');
    p = new Platform(cfg, createLogger('error', false));
    await p.start();
    const app = await buildApp(p);

    const health = (await app.inject({ url: '/api/health' })).json() as { mode: string; simulated: boolean; needsSetup: boolean };
    expect(health).toMatchObject({ mode: 'operational', simulated: false, needsSetup: true });
    const status = (await app.inject({ url: '/api/setup/status' })).json() as { needsAdmin: boolean; needsSite: boolean };
    expect(status).toMatchObject({ needsAdmin: true, needsSite: true });

    const demo = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'strata-demo' } });
    expect(demo.statusCode).toBe(401);

    const file = join(dir, 'setup-code.txt');
    expect(existsSync(file)).toBe(true);
    const code = readFileSync(file, 'utf8').trim();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/);

    expect((await app.inject({ method: 'POST', url: '/api/setup/verify', payload: { code: 'AAAA-AAAA' } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: 'POST', url: '/api/setup/verify', payload: { code } })).statusCode).toBe(200);

    const weak = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { code, username: 'rsharma', displayName: 'Maj R. Sharma', password: 'short' } });
    expect(weak.statusCode).toBe(400);
    const made = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { code, username: 'rsharma', displayName: 'Maj R. Sharma', password: 'Strong-Passw0rd-2026!' } });
    expect(made.statusCode).toBe(200);
    // The code is single use and its file is removed.
    expect(existsSync(file)).toBe(false);
    const again = await app.inject({ method: 'POST', url: '/api/setup/admin', payload: { code, username: 'other', displayName: 'Someone Else', password: 'Strong-Passw0rd-2026!' } });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'rsharma', password: 'Strong-Passw0rd-2026!' } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const after = (await app.inject({ url: '/api/setup/status', headers: { cookie } })).json() as { needsAdmin: boolean; needsSite: boolean };
    expect(after).toMatchObject({ needsAdmin: false, needsSite: true });

    // A device camera accepts pushed JPEG frames without ffmpeg; anything else is refused.
    const cam = await app.inject({ method: 'POST', url: '/api/cameras', headers: { cookie }, payload: { id: 'PHONE1', name: 'Ops room phone', binding: 'new', url: 'device:', enabled: true, pose: { lat: 28.7, lon: 77.35, heightM: 2, headingDeg: 0, pitchDeg: -10, hfovDeg: 70 }, analyticsFps: 1, detectObjects: false, recogniseFaces: false, tiled: false, loopFile: false } });
    expect(cam.statusCode).toBe(200);
    const notJpeg = await app.inject({ method: 'POST', url: '/api/cameras/PHONE1/frame', headers: { cookie, 'content-type': 'image/jpeg' }, payload: Buffer.from('not a jpeg') });
    expect(notJpeg.statusCode).toBeGreaterThanOrEqual(400);

    await app.close();
  }, 60_000);
});
