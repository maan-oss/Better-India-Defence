import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { FACILITY, getTerrainMode, restoreDemoSite, toMgrs, type SiteConfig } from '@strata/domain';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';

/** A real site replaces the demo model after restart: geometry, georeference, terrain, assets, simulator off. */
const dir = mkdtempSync(join(tmpdir(), 'strata-site-'));
const cfg = () => loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });

async function boot(): Promise<{ p: Platform; app: FastifyInstance; cookie: string }> {
  const p = new Platform(cfg(), createLogger('error', false));
  await p.start();
  const app = await buildApp(p);
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'strata-demo' } });
  return { p, app, cookie: String(r.headers['set-cookie']).split(';')[0]! };
}

const SITE: SiteConfig = {
  id: 'test-station',
  name: 'Test Station — North',
  origin: { lat: 28.5562, lon: 77.1, alt: 230 },
  halfExtentM: 1500,
  zones: [
    { id: 'zn-armoury', name: 'Armoury', kind: 'restricted', restricted: true, polygon: [{ x: 100, y: 100 }, { x: 220, y: 100 }, { x: 220, y: 200 }, { x: 100, y: 200 }] },
    { id: 'zn-lines', name: 'Unit lines', kind: 'controlled', restricted: false, polygon: [{ x: -400, y: -300 }, { x: 0, y: -300 }, { x: 0, y: 0 }, { x: -400, y: 0 }] },
  ],
  buildings: [{ id: 'bld-1', label: '1', name: 'Guard room', kind: 'gatehouse', center: { x: 0, y: -800 }, width: 12, depth: 8, height: 4, yawDeg: 0 }],
  perimeter: [{ x: -900, y: -900 }, { x: 900, y: -900 }, { x: 900, y: 900 }, { x: -900, y: 900 }],
  gates: [{ id: 'gate-main', name: 'Main gate', position: { x: 0, y: -900 } }],
  orthophoto: null,
};

afterAll(() => {
  restoreDemoSite();
  rmSync(dir, { recursive: true, force: true });
});

describe('site configuration', () => {
  it('validates and stores a site definition, then applies it on restart', async () => {
    const a = await boot();
    expect((await a.app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ simulated: true });
    expect((await a.app.inject({ method: 'PUT', url: '/api/site', headers: { cookie: a.cookie }, payload: { ...SITE, id: 'site-kestrel' } })).statusCode).toBe(400);
    expect((await a.app.inject({ method: 'PUT', url: '/api/site', headers: { cookie: a.cookie }, payload: { ...SITE, zones: [{ ...SITE.zones[0]!, polygon: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] } })).statusCode).toBe(400);
    const ok = await a.app.inject({ method: 'PUT', url: '/api/site', headers: { cookie: a.cookie }, payload: SITE });
    expect(ok.json()).toMatchObject({ ok: true, restartRequired: true });
    await a.app.close();
    await a.p.stop();

    const b = await boot();
    try {
      expect(FACILITY.id).toBe('test-station');
      expect(getTerrainMode()).toBe('flat');
      expect(FACILITY.fence).toHaveLength(4);
      expect(FACILITY.gates[0]!.fenceSegmentId).toBe('F-01');
      expect(FACILITY.sensors).toHaveLength(0);
      expect((await b.app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ simulated: false, site: 'test-station' });
      const f = (await b.app.inject({ method: 'GET', url: '/api/facility', headers: { cookie: b.cookie } })).json() as { facility: { zones: { id: string }[] }; terrain: string };
      expect(f.facility.zones.map((z) => z.id)).toEqual(['zn-armoury', 'zn-lines']);
      expect(f.terrain).toBe('flat');
      // Vital assets re-derived for the real site; demo assets and demo teams removed.
      const vas = (await b.app.inject({ method: 'GET', url: '/api/ops/vital-assets', headers: { cookie: b.cookie } })).json() as { id: string; name: string }[];
      expect(vas.map((v) => v.name)).toEqual(['Armoury']);
      const teams = (await b.app.inject({ method: 'GET', url: '/api/ops/teams', headers: { cookie: b.cookie } })).json() as unknown[];
      expect(teams).toHaveLength(0);
      // Grid references now come from the real anchor (New Delhi area → zone 43R).
      expect(toMgrs(FACILITY.origin.lat, FACILITY.origin.lon)).toMatch(/^43R/);
      // Demo sensors are no longer accepted.
      const r = await b.app.inject({ method: 'POST', url: '/api/ingest/batch', headers: { authorization: 'Bearer test-service-token-0123456789' }, payload: { messages: [{ schema: 'strata.ingest/v1', messageId: 'x-000001', sensorId: 'R01', adapter: 'test', seq: 1, observedAt: Date.now(), sentAt: Date.now(), kind: 'sensor.health', payload: { status: 'ok' } }] } });
      expect((r.json() as { rejected: { reason: string }[] }).rejected[0]?.reason).toMatch(/unregistered|schema/);
    } finally {
      await b.app.close();
      await b.p.stop();
    }
  }, 120_000);
});
