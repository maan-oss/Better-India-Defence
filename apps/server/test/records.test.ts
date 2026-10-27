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
 * Record discussion and link analysis, end to end: who may comment and who may only read, the rule that a record
 * a person cannot see is unknown (and its links are neither shown nor walked through), the depth limit, and a
 * thread the database itself refuses to change.
 */
const PASSWORD = 'Kestrel-7-Orbit-mapping';
let dir: string;
let platform: Platform;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const as = (who: string) => ({ cookie: cookies[who]! });
let main: string;
let lamp: string;
let vault: string;
let report: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-records-'));
  const cfg = loadConfig({ NODE_ENV: 'test', STRATA_MODE: 'operational', STRATA_MFA_REQUIRED: 'false', DATA_DIR: dir, STRATA_ADMIN_PASSWORD: PASSWORD, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
  platform = new Platform(cfg, createLogger('error', false));
  await platform.start();
  const a = platform.auth;
  await a.create('operator.one', 'Operator One', 'operator', PASSWORD);
  await a.create('analyst.one', 'Analyst One', 'analyst', PASSWORD);
  await a.create('viewer.one', 'Viewer One', 'viewer', PASSWORD);
  await a.create('secret.analyst', 'Secret Analyst', 'analyst', PASSWORD, { clearance: 'SECRET', organisation: 'site' });
  app = await buildApp(platform);
  for (const who of ['operator.one', 'analyst.one', 'viewer.one', 'secret.analyst']) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: who, password: PASSWORD } });
    cookies[who] = String(r.headers['set-cookie']).split(';')[0]!;
  }
  main = (await platform.assets.create({ tag: 'MAIN-7', name: 'Main feeder', category: 'power', criticality: 5 }, 'seed')).asset.id;
  lamp = (await platform.assets.create({ tag: 'LAMP-7', name: 'Lamp circuit', category: 'facilities', criticality: 2 }, 'seed')).asset.id;
  vault = (await platform.assets.create({ tag: 'VAULT-7', name: 'Vault door', category: 'security', criticality: 5, classification: 'SECRET' }, 'seed')).asset.id;
  // The feeder depends on the lamp circuit (visible to everyone) and the vault door (visible only to the secret analyst).
  await platform.db.query('INSERT INTO asset_dependencies (asset_id, depends_on_id, kind) VALUES ($1, $2, $3), ($1, $4, $5)', [main, lamp, 'power', vault, 'access']);
  const created = await app.inject({ method: 'POST', url: '/api/incident-reports', headers: as('operator.one'), payload: { title: 'Feeder fault', kind: 'power', description: 'Feeder tripped at 03:00.', assetIds: [main] } });
  expect(created.statusCode).toBe(200);
  report = created.json().id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const comments = (who: string, kind: string, id: string) => app.inject({ method: 'GET', url: `/api/records/${kind}/${id}/comments`, headers: as(who) });
const post = (who: string, kind: string, id: string, body: unknown) => app.inject({ method: 'POST', url: `/api/records/${kind}/${id}/comments`, headers: as(who), payload: { body } });
const links = (who: string, kind: string, id: string, depth?: number) => app.inject({ method: 'GET', url: `/api/records/${kind}/${id}/links${depth ? `?depth=${depth}` : ''}`, headers: as(who) });

describe('a comment on a record', () => {
  it('is added by an operator and read by anyone who can see the record', async () => {
    const added = await post('operator.one', 'incident_report', report, '  Breaker checked, feeder back on.  ');
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ recordKind: 'incident_report', recordId: report, author: 'operator.one', body: 'Breaker checked, feeder back on.' });

    const read = await comments('viewer.one', 'incident_report', report);
    expect(read.statusCode).toBe(200);
    expect(read.json().map((c: { body: string }) => c.body)).toEqual(['Breaker checked, feeder back on.']);
  });

  it('is refused to a viewer, to an empty body and to a body over the limit', async () => {
    expect((await post('viewer.one', 'incident_report', report, 'Looks fine')).statusCode).toBe(403);
    expect((await post('operator.one', 'incident_report', report, '   ')).statusCode).toBe(400);
    expect((await post('operator.one', 'incident_report', report, 'x'.repeat(2001))).statusCode).toBe(400);
  });

  it('is not shown for a record the person cannot see: the vault door is unknown to an analyst without SECRET', async () => {
    expect((await comments('analyst.one', 'asset', vault)).statusCode).toBe(404);
    expect((await post('analyst.one', 'asset', vault, 'Door sensor noisy')).statusCode).toBe(404);
    expect((await comments('secret.analyst', 'asset', vault)).statusCode).toBe(200);
  });

  it('cannot be changed or removed in the database', async () => {
    await post('operator.one', 'asset', lamp, 'Circuit isolated for inspection');
    await expect(platform.db.query("UPDATE record_comments SET body = 'edited' WHERE record_id = $1", [lamp])).rejects.toThrow(/append-only/);
    await expect(platform.db.query('DELETE FROM record_comments WHERE record_id = $1', [lamp])).rejects.toThrow(/append-only/);
  });
});

describe('the links around a record', () => {
  it('shows the equipment an incident report concerns, one step away', async () => {
    const r = await links('analyst.one', 'incident_report', report, 1);
    expect(r.statusCode).toBe(200);
    const g = r.json();
    expect(g.center).toBe(`incident_report:${report}`);
    expect(g.nodes.map((n: { label: string }) => n.label).sort()).toEqual(expect.arrayContaining(['MAIN-7']));
    expect(g.edges).toContainEqual({ from: `incident_report:${report}`, to: `asset:${main}`, label: 'linked equipment' });
  });

  it('walks to the equipment the feeder depends on at depth two, and reports the dependency', async () => {
    const g = (await links('analyst.one', 'incident_report', report, 2)).json();
    const byLabel = Object.fromEntries(g.nodes.map((n: { label: string; depth: number }) => [n.label, n.depth]));
    expect(byLabel).toMatchObject({ 'MAIN-7': 1, 'LAMP-7': 2 });
    expect(g.edges).toContainEqual({ from: `asset:${main}`, to: `asset:${lamp}`, label: 'depends on (power)' });
  });

  it('neither shows nor walks through a record the person cannot see', async () => {
    const hidden = (await links('analyst.one', 'asset', main, 2)).json();
    expect(hidden.nodes.map((n: { label: string }) => n.label)).not.toContain('VAULT-7');
    expect(hidden.edges.some((e: { to: string }) => e.to === `asset:${vault}`)).toBe(false);

    const cleared = (await links('secret.analyst', 'asset', main, 2)).json();
    expect(cleared.nodes.map((n: { label: string }) => n.label)).toContain('VAULT-7');
    expect(cleared.edges).toContainEqual({ from: `asset:${main}`, to: `asset:${vault}`, label: 'depends on (access)' });
  });

  it('refuses a depth beyond the limit and an unknown record', async () => {
    expect((await links('analyst.one', 'incident_report', report, 5)).statusCode).toBe(400);
    expect((await links('analyst.one', 'asset', vault)).statusCode).toBe(404);
  });
});
