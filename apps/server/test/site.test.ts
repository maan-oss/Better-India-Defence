import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildCot, EnuFrame, FACILITY, getTerrainMode, parseCot, restoreDemoSite, toMgrs, type SiteConfig } from '@strata/domain';
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
  feeds: [
    { id: 'GPS1', kind: 'gps', name: 'QRT AVL gateway' },
    { id: 'EXT1', kind: 'external', name: 'Brigade CoT feed', system: 'TAK' },
  ],
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
      expect(FACILITY.sensors.map((x) => `${x.id}:${x.kind}`)).toEqual(['GPS1:gps', 'EXT1:external']);
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

      // --- CoT interop: another system reports a hostile vehicle inside the armoury boundary and a friendly patrol.
      const frame = new EnuFrame(FACILITY.origin);
      const t0 = Date.now() - 3000;
      const xml = [0, 1, 2]
        .flatMap((k) => {
          const h = frame.toGeodetic({ x: 140 + k * 3, y: 150, z: 0 });
          const f = frame.toGeodetic({ x: -200, y: -150 + k * 2, z: 0 });
          return [
            buildCot({ uid: 'TAK-H-01', type: 'a-h-G-E-V', callsign: 'HOSTILE-1', lat: h.lat, lon: h.lon, hae: 230, ce: 8, le: 5, time: t0 + k * 1000, staleS: 60, courseDeg: 90, speedMps: 3 }),
            buildCot({ uid: 'TAK-F-07', type: 'a-f-G-U-C-I', callsign: 'PATROL-7', lat: f.lat, lon: f.lon, hae: 230, ce: 5, le: 5, time: t0 + k * 1000, staleS: 60 }),
          ];
        })
        .join('\n');
      const svc = { authorization: 'Bearer test-service-token-0123456789', 'content-type': 'application/xml' };
      const notFeed = await b.app.inject({ method: 'POST', url: '/api/interop/cot?sensorId=GPS1', headers: svc, payload: xml });
      expect(notFeed.statusCode).toBe(400);
      const cot = await b.app.inject({ method: 'POST', url: '/api/interop/cot?sensorId=EXT1', headers: svc, payload: xml });
      expect(cot.json()).toMatchObject({ events: 6, accepted: 6 });
      const tracks = (await b.app.inject({ method: 'GET', url: '/api/live/tracks', headers: { cookie: b.cookie } })).json() as { tracks: { label: string; cooperative: boolean; category: string; reported?: { affiliation: string; system: string } }[] };
      const hostile = tracks.tracks.find((x) => x.reported?.affiliation === 'hostile')!;
      expect(hostile).toMatchObject({ category: 'vehicle', cooperative: false, reported: { system: 'TAK' } });
      expect(tracks.tracks.find((x) => x.label === 'PATROL-7')).toMatchObject({ cooperative: true, category: 'person' });
      // The threat board ranks the reported-hostile vehicle against the armoury and shows the report as a factor.
      type Threat = { label: string; level: string; factors: { name: string }[] };
      let threats: Threat[] = [];
      for (let i = 0; i < 40 && !threats.some((x) => x.label === 'HOSTILE-1'); i++) {
        await new Promise((res) => setTimeout(res, 250));
        threats = (await b.app.inject({ method: 'GET', url: '/api/ops/threats', headers: { cookie: b.cookie } })).json() as Threat[];
      }
      const th = threats.find((x) => x.label === 'HOSTILE-1')!;
      expect(th.level).toBe('CRITICAL');
      expect(th.factors.map((f) => f.name)).toContain('reported hostile (TAK)');
      expect(threats.some((x) => x.label === 'PATROL-7')).toBe(false);

      // CoT out: tracks known only from the external feed are not echoed back; our own GPS track is published.
      const fix = (k: number) => {
        const g = frame.toGeodetic({ x: -50, y: -700 + k * 4, z: 0 });
        return { schema: 'strata.ingest/v1', messageId: `gps-qrt1-${k}-${t0}`, sensorId: 'GPS1', adapter: 'test', seq: k + 1, observedAt: t0 + k * 1000, sentAt: t0 + k * 1000, kind: 'gps.position', payload: { entityId: 'QRT-1', entityKind: 'vehicle', callsign: 'QRT-1', role: 'QRT', status: 'available', position: { lat: g.lat, lon: g.lon, alt: 230 }, accuracyM: 3 } };
      };
      await b.app.inject({ method: 'POST', url: '/api/ingest/batch', headers: { authorization: 'Bearer test-service-token-0123456789' }, payload: { messages: [0, 1, 2].map(fix) } });
      const out = (await b.app.inject({ method: 'GET', url: '/api/interop/cot', headers: { authorization: 'Bearer test-service-token-0123456789' } })).json() as { events: string[] };
      const parsed = out.events.map((e) => parseCot(e)).map((r) => (r.ok ? r.event : null));
      expect(parsed.some((e) => e?.callsign === 'HOSTILE-1')).toBe(false);
      const qrt = parsed.find((e) => e?.callsign === 'QRT-1')!;
      expect(qrt.uid).toMatch(/^strata\.test-station\./);
      expect(qrt.type).toBe('a-f-G-E-V');
      expect(Math.abs(qrt.lat - frame.toGeodetic({ x: -50, y: -692, z: 0 }).lat)).toBeLessThan(0.0002);
      expect((await b.app.inject({ method: 'GET', url: '/api/interop/cot' })).statusCode).toBe(401);
    } finally {
      await b.app.close();
      await b.p.stop();
    }
  }, 120_000);
});
