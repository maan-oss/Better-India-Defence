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
 * Asset and infrastructure register: permissions, status and impairment, impact analysis, dependency loops,
 * retirement, maintenance due state, validation, and the append-only history.
 */
const TOKEN = 'test-service-token-0123456789';
let dir: string;
let platform: Platform;
let app: FastifyInstance;
const ck: Record<string, string> = {};
const as = (u: string) => ({ cookie: ck[u]! });

type Asset = {
  id: string;
  tag: string;
  status: string;
  criticality: number;
  availability: { state: string; causes: string[] };
  plans: { id: string; title: string; due: { state: string } }[];
};
type Detail = { asset: Asset; upstream: { tag: string }[]; dependents: { tag: string; depth: number }[]; events: { kind: string }[] };

async function list(): Promise<Asset[]> {
  return (await app.inject({ method: 'GET', url: '/api/assets', headers: as('viewer') })).json() as Asset[];
}
async function byTag(tag: string): Promise<Asset> {
  const a = (await list()).find((x) => x.tag === tag);
  if (!a) throw new Error(`no asset ${tag}`);
  return a;
}
async function detail(id: string, who = 'viewer'): Promise<Detail> {
  return (await app.inject({ method: 'GET', url: `/api/assets/${id}`, headers: as(who) })).json() as Detail;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-assets-'));
  platform = new Platform(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, STRATA_SERVICE_TOKEN: TOKEN, SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' }), createLogger('error', false));
  await platform.start();
  app = await buildApp(platform);
  for (const u of ['viewer', 'operator', 'analyst']) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: 'strata-demo' } });
    ck[u] = String(r.headers['set-cookie']).split(';')[0]!;
  }
  await platform.assets.seedDemo();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('asset register', () => {
  it('seeds a synthetic register once, with degraded, impaired and due states present', async () => {
    expect(await platform.assets.seedDemo()).toBe(0);
    const assets = await list();
    expect(assets).toHaveLength(13);
    expect(assets.every((a) => (a as Asset & { source: string }).source === 'demo')).toBe(true);
    expect((await byTag('NVR-1')).availability.state).toBe('degraded');
    expect((await byTag('CAM-GATE')).availability.state).toBe('available');
    const ups = await byTag('UPS-1');
    expect(ups.plans.find((p) => p.title === 'Battery capacity test')?.due.state).toBe('overdue');
    expect(ups.plans.length).toBe(1);
    expect((await byTag('GEN-1')).plans.find((p) => p.title === 'Load bank test')?.due.state).toBe('never');
    expect((await byTag('PIDS-PERIM')).plans.find((p) => p.title === 'Sensor cable inspection')?.due.state).toBe('due_soon');
  });

  it('a viewer reads; an operator changes status; a fault is shown as down, and its dependents as impaired', async () => {
    const ups = await byTag('UPS-1');
    expect((await app.inject({ method: 'POST', url: `/api/assets/${ups.id}/status`, headers: as('viewer'), payload: { status: 'out_of_service', reason: 'test' } })).statusCode).toBe(403);
    const r = await app.inject({ method: 'POST', url: `/api/assets/${ups.id}/status`, headers: as('operator'), payload: { status: 'out_of_service', reason: 'Breaker tripped on test' } });
    expect(r.statusCode).toBe(200);
    expect((await byTag('UPS-1')).availability.state).toBe('down');
    const core = await byTag('CORE-SW');
    expect(core.availability).toMatchObject({ state: 'impaired', causes: [ups.id] });
    const events = (await detail(ups.id)).events.map((e) => e.kind);
    expect(events).toContain('status');
    // Restore so later steps start from the seeded state.
    expect((await app.inject({ method: 'POST', url: `/api/assets/${ups.id}/status`, headers: as('operator'), payload: { status: 'in_service', reason: 'Breaker reset' } })).statusCode).toBe(200);
    expect((await byTag('CORE-SW')).availability.state).toBe('available');
  });

  it('impact analysis lists exactly the assets that would change, and records nothing', async () => {
    const ups = await byTag('UPS-1');
    const r = await app.inject({ method: 'GET', url: `/api/assets/${ups.id}/impact?status=out_of_service`, headers: as('viewer') });
    expect(r.statusCode).toBe(200);
    const tags = (r.json() as { rows: { tag: string }[] }).rows.map((x) => x.tag).sort();
    expect(tags).toEqual(['AC-2', 'CAM-GATE', 'CORE-SW', 'GATE-N', 'NVR-1', 'PIDS-PERIM']);
    expect(tags).not.toContain('LIGHT-PER');
    expect(tags).not.toContain('RADIO-REP');
    expect((await byTag('UPS-1')).status).toBe('in_service');
    expect((await app.inject({ method: 'GET', url: `/api/assets/${ups.id}/impact?status=weird`, headers: as('viewer') })).statusCode).toBe(400);
  });

  it('the dependency graph needs analyst rights and refuses self-dependency, unknown targets and loops', async () => {
    const light = await byTag('LIGHT-PER');
    const mains = await byTag('MAINS-A');
    const camgate = await byTag('CAM-GATE');
    const put = (who: string, id: string, dependsOn: unknown[]) => app.inject({ method: 'PUT', url: `/api/assets/${id}/dependencies`, headers: as(who), payload: { dependsOn } });
    expect((await put('operator', light.id, [])).statusCode).toBe(403);
    expect((await put('viewer', light.id, [])).statusCode).toBe(403);
    expect((await put('analyst', light.id, [{ id: light.id, kind: 'power' }])).statusCode).toBe(400);
    expect((await put('analyst', light.id, [{ id: 'ast-does-not-exist', kind: 'power' }])).statusCode).toBe(400);
    // MAINS-A → … → CAM-GATE → ... would close a loop if MAINS depended on CAM-GATE.
    const loop = await put('analyst', mains.id, [{ id: camgate.id, kind: 'data' }]);
    expect(loop.statusCode).toBe(409);
    expect((loop.json() as { error: string }).error).toMatch(/loop/);
    expect((await put('analyst', light.id, [{ id: mains.id, kind: 'power' }, { id: mains.id, kind: 'power' }])).statusCode).toBe(400);
    // A valid change is recorded with before and after.
    const ups = await byTag('UPS-1');
    const ok = await put('analyst', light.id, [{ id: mains.id, kind: 'power' }, { id: ups.id, kind: 'power' }]);
    expect(ok.statusCode).toBe(200);
    expect((await detail(light.id)).upstream.map((u) => u.tag).sort()).toEqual(['MAINS-A', 'UPS-1']);
    expect((await detail(light.id)).events.map((e) => e.kind)).toContain('dependencies');
    expect((await put('analyst', light.id, [{ id: mains.id, kind: 'power' }])).statusCode).toBe(200);
  });

  it('retirement is refused while active assets depend on it, and final once it happens', async () => {
    const fuel = await byTag('FUEL-1');
    const gen = await byTag('GEN-1');
    const blocked = await app.inject({ method: 'POST', url: `/api/assets/${fuel.id}/retire`, headers: as('analyst'), payload: { reason: 'supplier change' } });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { error: string }).error).toMatch(/GEN-1/);
    expect((await app.inject({ method: 'POST', url: `/api/assets/${fuel.id}/retire`, headers: as('operator'), payload: { reason: 'x' } })).statusCode).toBe(403);
    // Re-point the generator first, then retirement is allowed.
    expect((await app.inject({ method: 'PUT', url: `/api/assets/${gen.id}/dependencies`, headers: as('analyst'), payload: { dependsOn: [] } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/assets/${fuel.id}/retire`, headers: as('analyst'), payload: { reason: 'supplier change' } })).statusCode).toBe(200);
    expect((await byTag('FUEL-1')).availability.state).toBe('retired');
    const veh = await byTag('VEH-1');
    expect((await app.inject({ method: 'POST', url: `/api/assets/${veh.id}/retire`, headers: as('analyst'), payload: { reason: 'written off' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/assets/${veh.id}/retire`, headers: as('analyst'), payload: { reason: 'again' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/assets/${veh.id}/status`, headers: as('operator'), payload: { status: 'degraded', reason: 'x' } })).statusCode).toBe(409);
    // A retired asset is read-only: no edits either.
    expect((await app.inject({ method: 'PATCH', url: `/api/assets/${veh.id}`, headers: as('operator'), payload: { name: 'Renamed' } })).statusCode).toBe(409);
  });

  it('a retired asset cannot become a new dependency, so nothing can be left depending on it', async () => {
    // Retirement is refused while dependents exist, so a retired upstream never has a live dependent through the API.
    const radio = await byTag('RADIO-REP');
    const veh = await byTag('VEH-1');
    const r = await app.inject({ method: 'PUT', url: `/api/assets/${radio.id}/dependencies`, headers: as('analyst'), payload: { dependsOn: [{ id: veh.id, kind: 'other' }] } });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: string }).error).toMatch(/retired/);
  });

  it('maintenance: completing a plan counts the next due date from now; plans can be added; viewers cannot record', async () => {
    const ups = await byTag('UPS-1');
    const plan = ups.plans.find((p) => p.title === 'Battery capacity test')!;
    expect((await app.inject({ method: 'POST', url: `/api/assets/${ups.id}/plans/${plan.id}/complete`, headers: as('viewer'), payload: {} })).statusCode).toBe(403);
    const done = await app.inject({ method: 'POST', url: `/api/assets/${ups.id}/plans/${plan.id}/complete`, headers: as('operator'), payload: { note: 'Passed at 92 % capacity' } });
    expect(done.statusCode).toBe(200);
    const after = (await byTag('UPS-1')).plans.find((p) => p.id === plan.id)!;
    expect(after.due.state).toBe('ok');
    expect((await detail(ups.id)).events.some((e) => e.kind === 'maintenance')).toBe(true);
    const added = await app.inject({ method: 'POST', url: `/api/assets/${ups.id}/plans`, headers: as('operator'), payload: { title: 'Insulation resistance', intervalDays: 180 } });
    expect(added.statusCode).toBe(200);
    expect((await byTag('UPS-1')).plans.find((p) => p.title === 'Insulation resistance')?.due.state).toBe('never');
    expect((await app.inject({ method: 'POST', url: `/api/assets/${ups.id}/plans`, headers: as('operator'), payload: { title: 'Bad', intervalDays: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/assets/${ups.id}/plans/no-such-plan/complete`, headers: as('operator'), payload: {} })).statusCode).toBe(404);
  });

  it('validates input, enforces tag uniqueness, and records creates and edits', async () => {
    const create = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/assets', headers: as('operator'), payload });
    const base = { tag: 'TEST-1', name: 'Test asset', category: 'other', criticality: 2 };
    expect((await create({ ...base, tag: 'bad tag' })).statusCode).toBe(400);
    expect((await create({ ...base, criticality: 9 })).statusCode).toBe(400);
    expect((await create({ ...base, category: 'weapon-system' })).statusCode).toBe(400);
    expect((await create({ ...base, tag: 'UPS-1' })).statusCode).toBe(409);
    const made = await create(base);
    expect(made.statusCode).toBe(200);
    const id = (made.json() as Detail).asset.id;
    expect(made.json()).toMatchObject({ asset: { tag: 'TEST-1', status: 'in_service', availability: { state: 'available' } } });
    const patch = await app.inject({ method: 'PATCH', url: `/api/assets/${id}`, headers: as('operator'), payload: { criticality: 4, notes: 'Moved to the north store' } });
    expect(patch.statusCode).toBe(200);
    const kinds = (await detail(id)).events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['created', 'edited']));
    expect((await app.inject({ method: 'PATCH', url: `/api/assets/${id}`, headers: as('operator'), payload: { tag: 'OTHER' } })).statusCode).toBe(400);
  });

  it('an asset is addressed by its id or its tag, and an unknown reference is a 404', async () => {
    const ups = await byTag('UPS-1');
    const byIdRes = (await app.inject({ method: 'GET', url: `/api/assets/${ups.id}`, headers: as('viewer') })).json() as Detail;
    const byTagRes = (await app.inject({ method: 'GET', url: '/api/assets/UPS-1', headers: as('viewer') })).json() as Detail;
    expect(byTagRes.asset.id).toBe(ups.id);
    expect(byTagRes.asset).toEqual(byIdRes.asset);
    expect((await app.inject({ method: 'GET', url: '/api/assets/NO-SUCH-1', headers: as('viewer') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/assets/NO-SUCH-1/status', headers: as('operator'), payload: { status: 'degraded', reason: 'x' } })).statusCode).toBe(404);
  });

  it('history is append-only at the database, and the audit chain still verifies', async () => {
    await expect(platform.db.query(`UPDATE asset_events SET actor = 'someone-else'`)).rejects.toThrow(/append-only/);
    await expect(platform.db.query(`DELETE FROM asset_events`)).rejects.toThrow(/append-only/);
    const v = (await app.inject({ method: 'GET', url: '/api/audit/verify', headers: as('analyst') })).json() as { ok: boolean };
    expect(v.ok).toBe(true);
    const audited = await platform.db.query<{ action: string }>(`SELECT action FROM audit_events WHERE action LIKE 'asset_%'`);
    expect(audited.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['asset_status_changed', 'asset_dependencies_changed', 'asset_retired', 'asset_maintenance_completed', 'asset_created']));
  });
});
