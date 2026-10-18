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
 * Incident reports end to end: the lifecycle and its refusals, escalation from the criticality of linked equipment, the
 * rule that the reporter cannot verify and the resolver cannot review, visibility by clearance and organisation, and a
 * history that the database itself refuses to change.
 */
const PASSWORD = 'Kestrel-7-Orbit-mapping';
let dir: string;
let platform: Platform;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const as = (who: string) => ({ cookie: cookies[who]! });
let critical: string;
let routine: string;
let hidden: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-reports-'));
  const cfg = loadConfig({ NODE_ENV: 'test', STRATA_MODE: 'operational', STRATA_MFA_REQUIRED: 'false', DATA_DIR: dir, STRATA_ADMIN_PASSWORD: PASSWORD, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
  platform = new Platform(cfg, createLogger('error', false));
  await platform.start();
  const a = platform.auth;
  await a.create('guard.one', 'Guard One', 'operator', PASSWORD);
  await a.create('operator.one', 'Operator One', 'operator', PASSWORD);
  await a.create('analyst.one', 'Analyst One', 'analyst', PASSWORD);
  await a.create('analyst.two', 'Analyst Two', 'analyst', PASSWORD);
  await a.create('viewer.one', 'Viewer One', 'viewer', PASSWORD);
  await a.create('secret.analyst', 'Secret Analyst', 'analyst', PASSWORD, { clearance: 'SECRET', organisation: 'site' });
  app = await buildApp(platform);
  for (const who of ['guard.one', 'operator.one', 'analyst.one', 'analyst.two', 'viewer.one', 'secret.analyst']) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: who, password: PASSWORD } });
    cookies[who] = String(r.headers['set-cookie']).split(';')[0]!;
  }
  critical = (await platform.assets.create({ tag: 'MAIN-9', name: 'Main feeder', category: 'power', criticality: 5 }, 'seed')).asset.id;
  routine = (await platform.assets.create({ tag: 'LAMP-9', name: 'Lamp circuit', category: 'facilities', criticality: 2 }, 'seed')).asset.id;
  hidden = (await platform.assets.create({ tag: 'VAULT-9', name: 'Vault door', category: 'security', criticality: 5, classification: 'SECRET' }, 'seed')).asset.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const create = (who: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/incident-reports', headers: as(who), payload: { title: 'Gate sensor fault', kind: 'intrusion', description: 'Gate sensor reported a fault at 02:10.', ...payload } });
const step = (who: string, id: string, to: string, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/api/incident-reports/${id}/transition`, headers: as(who), payload: { to, ...extra } });

describe('a watch incident', () => {
  it('is reported, verified by an analyst, responded to, resolved and reviewed by a different analyst', async () => {
    const created = await create('guard.one', {});
    expect(created.statusCode).toBe(200);
    const r = created.json();
    expect(r).toMatchObject({ state: 'reported', level: 'watch', reportedBy: 'guard.one', nextSteps: [] });
    expect(r.code).toMatch(/^IR-\d{8}-\d{3}$/);

    const byReporter = await step('guard.one', r.id, 'verified');
    expect(byReporter.statusCode).toBe(403);

    const verified = await step('analyst.one', r.id, 'verified');
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ state: 'verified', verifiedBy: 'analyst.one' });

    const responding = await step('operator.one', r.id, 'responding');
    expect(responding.statusCode).toBe(200);
    const resolved = await step('operator.one', r.id, 'resolved', { note: 'Sensor cable reseated' });
    expect(resolved.json()).toMatchObject({ state: 'resolved', resolvedBy: 'operator.one', resolution: 'Sensor cable reseated' });

    const reviewedByResolver = await app.inject({ method: 'POST', url: `/api/incident-reports/${r.id}/review`, headers: as('analyst.one'), payload: { summary: 'Fault traced', lessons: 'Check cable runs' } });
    expect(reviewedByResolver.statusCode).toBe(200);
    expect(reviewedByResolver.json()).toMatchObject({ state: 'reviewed', reviewedBy: 'analyst.one', lessons: 'Check cable runs' });

    const detail = (await app.inject({ method: 'GET', url: `/api/incident-reports/${r.id}`, headers: as('viewer.one') })).json();
    expect(detail.events.map((e: { kind: string }) => e.kind)).toEqual(['reported', 'state:verified', 'state:responding', 'state:resolved', 'state:reviewed']);
  });
});

describe('escalation from equipment criticality', () => {
  it('requires a command incident to be escalated before it is responded to', async () => {
    const r = (await create('guard.one', { title: 'Main feeder alarm', assetIds: [critical] })).json();
    expect(r.level).toBe('command');
    await step('analyst.one', r.id, 'verified');
    const skipped = await step('operator.one', r.id, 'responding');
    expect(skipped.statusCode).toBe(409);
    expect(skipped.json().error).toMatch(/escalated before it is responded to/);
    const escalated = await step('operator.one', r.id, 'escalated', { note: 'Duty officer informed' });
    expect(escalated.json()).toMatchObject({ state: 'escalated' });
    expect((await step('operator.one', r.id, 'responding')).statusCode).toBe(200);
  });

  it('keeps a watch incident off escalation', async () => {
    const r = (await create('guard.one', { title: 'Lamp out', assetIds: [routine] })).json();
    expect(r.level).toBe('watch');
    await step('analyst.one', r.id, 'verified');
    const escalate = await step('operator.one', r.id, 'escalated');
    expect(escalate.statusCode).toBe(409);
  });
});

describe('who may do what', () => {
  it('refuses a resolver who asks to review their own resolution, and accepts a different analyst', async () => {
    const r = (await create('guard.one', { title: 'Access reader offline' })).json();
    await step('analyst.one', r.id, 'verified');
    await step('analyst.one', r.id, 'responding');
    await step('analyst.one', r.id, 'resolved', { note: 'Reader restarted' });
    const own = await app.inject({ method: 'POST', url: `/api/incident-reports/${r.id}/review`, headers: as('analyst.one'), payload: { summary: 'Mine' } });
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toMatch(/cannot review/);
    const other = await app.inject({ method: 'POST', url: `/api/incident-reports/${r.id}/review`, headers: as('analyst.two'), payload: { summary: 'Reviewed' } });
    expect(other.statusCode).toBe(200);
  });

  it('refuses a review by an operator, who lacks the review permission', async () => {
    const r = (await create('guard.one', { title: 'Camera offline' })).json();
    const review = await app.inject({ method: 'POST', url: `/api/incident-reports/${r.id}/review`, headers: as('operator.one'), payload: { summary: 'x' } });
    expect(review.statusCode).toBe(403);
  });

  it('refuses a link to equipment the person cannot see, as an unknown record', async () => {
    const r = (await create('guard.one', { title: 'Vault check' })).json();
    const link = await app.inject({ method: 'POST', url: `/api/incident-reports/${r.id}/assets`, headers: as('guard.one'), payload: { assetId: hidden } });
    expect(link.statusCode).toBe(400);
    expect(link.json().error).toMatch(/unknown/);
  });
});

describe('visibility', () => {
  it('hides a report above a person\'s clearance from them, as if it did not exist', async () => {
    const top = (await create('secret.analyst', { title: 'Sensitive approach', classification: 'SECRET' })).json();
    const viewer = await app.inject({ method: 'GET', url: `/api/incident-reports/${top.id}`, headers: as('viewer.one') });
    expect(viewer.statusCode).toBe(404);
    const listed = (await app.inject({ method: 'GET', url: '/api/incident-reports', headers: as('viewer.one') })).json();
    expect(listed.find((x: { id: string }) => x.id === top.id)).toBeUndefined();
    const owner = await app.inject({ method: 'GET', url: `/api/incident-reports/${top.id}`, headers: as('secret.analyst') });
    expect(owner.statusCode).toBe(200);
  });

  it('refuses to create a report above the reporter\'s clearance', async () => {
    const r = await create('guard.one', { classification: 'SECRET' });
    expect(r.statusCode).toBe(403);
  });
});

describe('the history', () => {
  it('cannot be changed or removed, even by a direct database statement', async () => {
    const r = (await create('guard.one', { title: 'History check' })).json();
    await expect(platform.db.query(`UPDATE incident_report_events SET actor = 'someone' WHERE report_id = $1`, [r.id])).rejects.toThrow(/append-only/);
    await expect(platform.db.query(`DELETE FROM incident_report_events WHERE report_id = $1`, [r.id])).rejects.toThrow(/append-only/);
  });
});
