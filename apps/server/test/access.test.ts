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
 * Clearance and organisation on the asset register. Four records (public, shared, secret, and another organisation's
 * own) and four people: each sees exactly what the rule allows, a hidden record looks like a missing one, sharing
 * grants view but not change, and a relation to a hidden record is withheld and counted.
 */
const PASSWORD = 'Kestrel-7-Orbit-mapping';
let dir: string;
let platform: Platform;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

const as = (who: string) => ({ cookie: cookies[who]! });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-access-'));
  const cfg = loadConfig({
    NODE_ENV: 'test',
    STRATA_MODE: 'operational',
    STRATA_MFA_REQUIRED: 'false',
    DATA_DIR: dir,
    STRATA_ADMIN_PASSWORD: PASSWORD,
    STRATA_SERVICE_TOKEN: 'test-service-token-0123456789',
    SIM_URL: 'http://127.0.0.1:9',
    LOG_LEVEL: 'error',
  });
  platform = new Platform(cfg, createLogger('error', false));
  await platform.start();
  const a = platform.auth;
  await a.create('ops.logistics', 'Logistics Operator', 'operator', PASSWORD, { clearance: 'CONFIDENTIAL', organisation: 'logistics' });
  await a.create('ops.engineering', 'Engineering Operator', 'operator', PASSWORD, { clearance: 'RESTRICTED', organisation: 'engineering' });
  await a.create('viewer.site', 'Site Viewer', 'viewer', PASSWORD, { clearance: 'UNCLASSIFIED', organisation: 'site' });
  await a.create('analyst.logistics', 'Logistics Analyst', 'analyst', PASSWORD, { clearance: 'CONFIDENTIAL', organisation: 'logistics' });
  await a.create('admin.logistics', 'Logistics Administrator', 'administrator', PASSWORD, { clearance: 'SECRET', organisation: 'logistics' });
  app = await buildApp(platform);
  for (const who of ['ops.logistics', 'ops.engineering', 'viewer.site', 'analyst.logistics', 'admin.logistics']) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: who, password: PASSWORD } });
    cookies[who] = String(r.headers['set-cookie']).split(';')[0]!;
  }
  const make = async (tag: string, classification: 'UNCLASSIFIED' | 'RESTRICTED' | 'SECRET', owner: string, sharedWith: string[] = []) => {
    const d = await platform.assets.create({ tag, name: `${tag} item`, category: 'power', criticality: 3, classification, owner, sharedWith }, 'seed');
    ids[tag] = d.asset.id;
  };
  await make('PUB-1', 'UNCLASSIFIED', 'logistics');
  await make('RES-1', 'RESTRICTED', 'engineering', ['logistics']);
  await make('SEC-1', 'SECRET', 'logistics');
  await make('ENG-1', 'RESTRICTED', 'engineering');
  await platform.assets.setDependencies(ids['PUB-1']!, [{ id: ids['ENG-1']!, kind: 'power' }], 'seed');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const visibleTo = async (who: string) => ((await app.inject({ method: 'GET', url: '/api/assets', headers: as(who) })).json() as { tag: string }[]).map((a) => a.tag).sort();

describe('what each person can see', () => {
  it('shows a logistics operator the public and the shared record, not the secret or the other organisation\'s private one', async () => {
    expect(await visibleTo('ops.logistics')).toEqual(['PUB-1', 'RES-1']);
  });

  it('shows an engineering operator its own records only', async () => {
    expect(await visibleTo('ops.engineering')).toEqual(['ENG-1', 'RES-1']);
  });

  it('shows a site viewer nothing: no record of its own, and nothing shared with it', async () => {
    expect(await visibleTo('viewer.site')).toEqual([]);
  });

  it('shows an administrator with secret clearance the secret record it owns, and nothing it does not own or share', async () => {
    expect(await visibleTo('admin.logistics')).toEqual(['PUB-1', 'RES-1', 'SEC-1']);
  });
});

describe('a hidden record is unknown, and a shared one can be viewed but not changed', () => {
  it('reports a record the person cannot see as unknown, the same as a missing one', async () => {
    const hidden = await app.inject({ method: 'GET', url: `/api/assets/${ids['ENG-1']}`, headers: as('ops.logistics') });
    const missing = await app.inject({ method: 'GET', url: '/api/assets/ast-does-not-exist', headers: as('ops.logistics') });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'unknown asset' });
    expect(missing.json()).toEqual({ error: 'unknown asset' });
  });

  it('lets the recipient view a shared record, and refuses it a change with the reason', async () => {
    const view = await app.inject({ method: 'GET', url: `/api/assets/${ids['RES-1']}`, headers: as('ops.logistics') });
    expect(view.statusCode).toBe(200);
    const change = await app.inject({ method: 'PATCH', url: `/api/assets/${ids['RES-1']}`, headers: as('ops.logistics'), payload: { notes: 'changed' } });
    expect(change.statusCode).toBe(403);
    expect(change.json().error).toMatch(/another organisation/);
  });

  it('refuses a secret record to someone without the clearance, even if it is their own organisation\'s', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/assets/${ids['SEC-1']}`, headers: as('ops.logistics') });
    expect(r.statusCode).toBe(404);
  });
});

describe('creating and changing classification and owner', () => {
  it('creates at or below the clearance, in the creator\'s organisation', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/assets', headers: as('ops.logistics'), payload: { tag: 'NEW-1', name: 'New item', category: 'power', criticality: 2, classification: 'RESTRICTED' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().asset).toMatchObject({ classification: 'RESTRICTED', owner: 'logistics' });
    const above = await app.inject({ method: 'POST', url: '/api/assets', headers: as('ops.logistics'), payload: { tag: 'NEW-2', name: 'Above', category: 'power', criticality: 2, classification: 'SECRET' } });
    expect(above.statusCode).toBe(403);
    expect(above.json().error).toMatch(/above your clearance/);
  });

  it('refuses an operator who names another organisation as owner, but lets an administrator do so', async () => {
    const refused = await app.inject({ method: 'POST', url: '/api/assets', headers: as('ops.logistics'), payload: { tag: 'NEW-3', name: 'Other', category: 'power', criticality: 2, owner: 'engineering' } });
    expect(refused.statusCode).toBe(403);
    const allowed = await app.inject({ method: 'POST', url: '/api/assets', headers: as('admin.logistics'), payload: { tag: 'NEW-4', name: 'Handed over', category: 'power', criticality: 2, owner: 'engineering' } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().asset.owner).toBe('engineering');
  });

  it('refuses a change to a record above the person\'s clearance, and a transfer by anyone but an administrator', async () => {
    const up = await app.inject({ method: 'PATCH', url: `/api/assets/${ids['PUB-1']}`, headers: as('ops.logistics'), payload: { classification: 'SECRET' } });
    expect(up.statusCode).toBe(403);
    expect(up.json().error).toMatch(/above your clearance/);
    const transfer = await app.inject({ method: 'PATCH', url: `/api/assets/${ids['PUB-1']}`, headers: as('ops.logistics'), payload: { owner: 'engineering' } });
    expect(transfer.statusCode).toBe(403);
  });

  it('lets an administrator of the owning organisation transfer and share a record', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/api/assets/${ids['PUB-1']}`, headers: as('admin.logistics'), payload: { sharedWith: ['site'] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().asset.sharedWith).toEqual(['site']);
    expect(await visibleTo('viewer.site')).toEqual(['PUB-1']);
  });
});

describe('relations to hidden records', () => {
  it('refuses a dependency on a record the person cannot see, as an unknown asset', async () => {
    const r = await app.inject({ method: 'PUT', url: `/api/assets/${ids['PUB-1']}/dependencies`, headers: as('analyst.logistics'), payload: { dependsOn: [{ id: ids['ENG-1'], kind: 'power' }] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/unknown asset/);
  });

  it('withholds and counts the upstream records the person cannot see, without naming them', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/assets/${ids['PUB-1']}`, headers: as('analyst.logistics') });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.upstream).toEqual([]);
    expect(body.withheld).toEqual({ upstream: 1, dependents: 0 });
    expect(JSON.stringify(body)).not.toContain('ENG-1');
  });
});
