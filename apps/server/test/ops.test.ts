import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SimulatorEngine } from '@strata/simulator';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';

/** Operations: readiness, threat evaluation on a live drone incursion, dispatch with ETA, duty log, handover, SITREP. */
const TOKEN = 'test-service-token-0123456789';
let dir: string;
let platform: Platform;
let app: FastifyInstance;
const ck: Record<string, string> = {};
const as = (u: string) => ({ cookie: ck[u]! });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-ops-'));
  platform = new Platform(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, STRATA_SERVICE_TOKEN: TOKEN, SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' }), createLogger('error', false));
  await platform.start();
  app = await buildApp(platform);
  for (const u of ['viewer', 'operator', 'analyst']) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: 'strata-demo' } });
    ck[u] = String(r.headers['set-cookie']).split(';')[0]!;
  }
  // Drive a drone incursion up to "now" so live threat evaluation sees it.
  const now = Date.now();
  const t0 = now - 6 * 60_000;
  const engine = new SimulatorEngine([{ id: 'x', key: 'UNIDENTIFIED_DRONE', t0: t0 + 30_000, source: 'recording' }]);
  for (let t = t0; t <= now - 1000; t += 1000) {
    const msgs = engine.step(t).messages.filter((m) => m.kind !== 'lidar.scan' && m.kind !== 'imagery.capture');
    if (msgs.length) await app.inject({ method: 'POST', url: '/api/ingest/batch', headers: { authorization: `Bearer ${TOKEN}` }, payload: { messages: msgs } });
  }
  await platform.ingest.tick(now - 1000);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('operations', () => {
  it('seeds vital assets from restricted zones and demo response teams', async () => {
    const vas = (await app.inject({ method: 'GET', url: '/api/ops/vital-assets', headers: as('viewer') })).json() as { id: string }[];
    expect(vas.length).toBeGreaterThanOrEqual(3);
    const teams = (await app.inject({ method: 'GET', url: '/api/ops/teams', headers: as('viewer') })).json() as { callsign: string }[];
    expect(teams.map((t) => t.callsign)).toContain('QRT-1');
  });

  it('readiness changes require analyst rights, a reason, and are logged', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/ops/readiness', headers: as('operator'), payload: { level: 'ALERT', reason: 'drone' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/ops/readiness', headers: as('analyst'), payload: { level: 'ALERT' } })).statusCode).toBe(400);
    const r = await app.inject({ method: 'POST', url: '/api/ops/readiness', headers: as('analyst'), payload: { level: 'ALERT', reason: 'UAS activity over airside' } });
    expect((r.json() as { level: string }).level).toBe('ALERT');
    const log = (await app.inject({ method: 'GET', url: '/api/ops/log', headers: as('viewer') })).json() as { kind: string; text: string }[];
    expect(log.some((l) => l.kind === 'readiness' && l.text.includes('NORMAL → ALERT'))).toBe(true);
  });

  it('the duty log is append-only at the database', async () => {
    await expect(platform.db.query(`UPDATE log_entries SET text = 'x'`)).rejects.toThrow(/append-only/);
    await expect(platform.db.query(`DELETE FROM log_entries`)).rejects.toThrow(/append-only/);
  });

  it('evaluates the drone against vital assets', async () => {
    await new Promise((r) => setTimeout(r, 2500)); // one evaluation cycle
    const threats = (await app.inject({ method: 'GET', url: '/api/ops/threats', headers: as('viewer') })).json() as { category: string; score: number; assetName: string; rangeM: number }[];
    const aerial = threats.find((t) => t.category === 'aerial');
    expect(aerial).toBeDefined();
    expect(aerial!.score).toBeGreaterThan(0);
  });

  it('dispatches a team to an alert with an ETA, acknowledges the alert and records the task lifecycle', async () => {
    const alert = (await platform.db.query<{ id: string }>(`SELECT id FROM alerts WHERE rule = 'UNIDENTIFIED_AERIAL' LIMIT 1`)).rows[0]!;
    const teams = (await app.inject({ method: 'GET', url: '/api/ops/teams', headers: as('operator') })).json() as { id: string; callsign: string; position: unknown }[];
    const qrt = teams.find((t) => t.callsign === 'QRT-1')!;
    const t = (await app.inject({ method: 'POST', url: '/api/ops/tasks', headers: as('operator'), payload: { teamId: qrt.id, alertId: alert.id, orders: 'Move to RF bearing origin, locate controller, report' } })).json() as { id: string; status: string; etaS: number | null; mgrs: string | null };
    expect(t.status).toBe('ISSUED');
    expect(t.mgrs).toMatch(/^\d{1,2}[A-Z] [A-Z]{2} \d{5} \d{5}$/);
    const again = await app.inject({ method: 'POST', url: '/api/ops/tasks', headers: as('operator'), payload: { teamId: qrt.id, orders: 'second task' } });
    expect(again.statusCode).toBe(400);
    const a = (await platform.db.query<{ status: string }>('SELECT status FROM alerts WHERE id = $1', [alert.id])).rows[0]!;
    expect(a.status).toBe('acknowledged');
    const done = (await app.inject({ method: 'POST', url: `/api/ops/tasks/${t.id}/status`, headers: as('operator'), payload: { status: 'COMPLETE', outcome: 'Controller not found; area searched' } })).json() as { status: string };
    expect(done.status).toBe('COMPLETE');
  });

  it('checklists follow the SOP for the alert type', async () => {
    const alert = (await platform.db.query<{ id: string }>(`SELECT id FROM alerts WHERE rule = 'UNIDENTIFIED_AERIAL' LIMIT 1`)).rows[0]!;
    const c = (await app.inject({ method: 'GET', url: `/api/ops/checklists/${alert.id}`, headers: as('operator') })).json() as { items: { text: string }[] };
    expect(c.items[1]!.text).toMatch(/air defence/i);
    const r = (await app.inject({ method: 'POST', url: `/api/ops/checklists/${alert.id}/1`, headers: as('operator'), payload: {} })).json() as { items: { doneBy: string | null }[] };
    expect(r.items[1]!.doneBy).toBe('operator');
  });

  it('watch handover can only be accepted by the named incoming officer', async () => {
    const h = (await app.inject({ method: 'POST', url: '/api/ops/handovers', headers: as('operator'), payload: { incoming: 'analyst', summary: 'Drone incursion ongoing, QRT-1 searched sector' } })).json() as { id: string };
    expect((await app.inject({ method: 'POST', url: `/api/ops/handovers/${h.id}/accept`, headers: as('viewer') })).statusCode).toBe(403); // no duty-log rights
    expect((await app.inject({ method: 'POST', url: `/api/ops/handovers/${h.id}/accept`, headers: as('operator') })).statusCode).toBe(400); // not the named incoming officer
    expect((await app.inject({ method: 'POST', url: `/api/ops/handovers/${h.id}/accept`, headers: as('analyst') })).statusCode).toBe(200);
  });

  it('drafts a SITREP from the record, issues it immutably and amends by new version', async () => {
    const s = (await app.inject({ method: 'POST', url: '/api/ops/sitreps', headers: as('analyst'), payload: { classification: 'RESTRICTED' } })).json() as { id: string; dtg: string; sections: { key: string; text: string }[] };
    expect(s.dtg).toMatch(/^\d{6}Z [A-Z]{3} \d{2}$/);
    expect(s.sections.find((x) => x.key === 'own')!.text).toContain('QRT-1');
    expect(s.sections.find((x) => x.key === 'actions')!.text).toContain('Readiness NORMAL → ALERT');
    await app.inject({ method: 'POST', url: `/api/ops/sitreps/${s.id}/issue`, headers: as('analyst') });
    const edit = await app.inject({ method: 'PUT', url: `/api/ops/sitreps/${s.id}`, headers: as('analyst'), payload: { sections: s.sections, classification: 'SECRET' } });
    expect(edit.statusCode).toBe(400);
    const amend = (await app.inject({ method: 'POST', url: `/api/ops/sitreps/${s.id}/amend`, headers: as('analyst') })).json() as { version: number; status: string; supersedes: string };
    expect(amend).toMatchObject({ version: 2, status: 'DRAFT', supersedes: s.id });
  });
});
