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
 * Stock on the dependency graph: a stock-out impairs what depends on the item; a receipt restores it; an issue cannot go
 * below zero; a reorder is requested by an operator and takes effect only when an analyst who did not request it approves.
 */
const PASSWORD = 'Kestrel-7-Orbit-mapping';
let dir: string;
let platform: Platform;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
let ups: string;
let diesel: string;

const as = (who: string) => ({ cookie: cookies[who]! });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-stock-'));
  const cfg = loadConfig({ NODE_ENV: 'test', STRATA_MODE: 'operational', STRATA_MFA_REQUIRED: 'false', DATA_DIR: dir, STRATA_ADMIN_PASSWORD: PASSWORD, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
  platform = new Platform(cfg, createLogger('error', false));
  await platform.start();
  await platform.auth.create('ops.power', 'Power Operator', 'operator', PASSWORD);
  await platform.auth.create('analyst.power', 'Power Analyst', 'analyst', PASSWORD);
  await platform.auth.create('analyst.two', 'Second Analyst', 'analyst', PASSWORD);
  app = await buildApp(platform);
  for (const who of ['ops.power', 'analyst.power', 'analyst.two']) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: who, password: PASSWORD } });
    cookies[who] = String(r.headers['set-cookie']).split(';')[0]!;
  }
  const u = await platform.assets.create({ tag: 'UPS-9', name: 'UPS', category: 'power', criticality: 4 }, 'seed');
  const d = await platform.assets.create({ tag: 'DSL-9', name: 'Diesel store', category: 'supply', criticality: 3, stock: { quantity: 1, reorderLevel: 3, unit: 'drums' } }, 'seed');
  ups = u.asset.id;
  diesel = d.asset.id;
  await platform.assets.setDependencies(ups, [{ id: diesel, kind: 'fuel' }], 'seed');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('stock', () => {
  it('shows low stock on the item, and no stock on a record that is not a supply item', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/assets/${diesel}`, headers: as('ops.power') });
    expect(r.json().asset.stock).toMatchObject({ quantity: 1, reorderLevel: 3, unit: 'drums', lowStock: true, outOfStock: false });
    const u = await app.inject({ method: 'GET', url: `/api/assets/${ups}`, headers: as('ops.power') });
    expect(u.json().asset.stock).toBeNull();
  });

  it('refuses stock on a record that is not a supply item at creation', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/assets', headers: as('ops.power'), payload: { tag: 'BAD-1', name: 'Bad', category: 'power', criticality: 1, stock: { quantity: 1, reorderLevel: 0, unit: 'each' } } });
    expect(r.statusCode).toBe(400);
  });

  it('issues stock down to a stock-out, which impairs the dependent, and refuses an issue below zero', async () => {
    const issue = await app.inject({ method: 'POST', url: `/api/assets/${diesel}/stock`, headers: as('ops.power'), payload: { change: -2, reason: 'generator run' } });
    expect(issue.statusCode).toBe(409);
    expect(issue.json().error).toMatch(/cannot issue 2/);
    const ok = await app.inject({ method: 'POST', url: `/api/assets/${diesel}/stock`, headers: as('ops.power'), payload: { change: -1, reason: 'generator run' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().asset.stock).toMatchObject({ quantity: 0, outOfStock: true });
    const dependent = await app.inject({ method: 'GET', url: `/api/assets/${ups}`, headers: as('ops.power') });
    expect(dependent.json().asset.availability).toEqual({ id: ups, state: 'impaired', causes: [diesel] });
    expect(dependent.json().asset.availability.state).toBe('impaired');
  });

  it('restores the dependent when stock is received', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/assets/${diesel}/stock`, headers: as('ops.power'), payload: { change: 5, reason: 'delivery 1871' } });
    expect(r.statusCode).toBe(200);
    const dependent = await app.inject({ method: 'GET', url: `/api/assets/${ups}`, headers: as('ops.power') });
    expect(dependent.json().asset.availability.state).toBe('available');
  });

  it('requests a reorder that takes no effect until another analyst approves it', async () => {
    const request = await app.inject({ method: 'POST', url: `/api/assets/${diesel}/reorders`, headers: as('ops.power'), payload: { quantity: 10, reason: 'winter stock' } });
    expect(request.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/reorders', headers: as('ops.power') });
    const req = list.json().find((r: { tag: string }) => r.tag === 'DSL-9');
    expect(req).toMatchObject({ status: 'requested', quantity: 10, requestedBy: 'ops.power' });
    const operatorDecides = await app.inject({ method: 'POST', url: `/api/reorders/${req.id}/decision`, headers: as('ops.power'), payload: { decision: 'approve' } });
    expect(operatorDecides.statusCode).toBe(403);
    const analystDecides = await app.inject({ method: 'POST', url: `/api/reorders/${req.id}/decision`, headers: as('analyst.power'), payload: { decision: 'approve', note: 'within budget' } });
    expect(analystDecides.statusCode).toBe(200);
    expect(analystDecides.json()).toMatchObject({ status: 'approved', decidedBy: 'analyst.power' });
    const again = await app.inject({ method: 'POST', url: `/api/reorders/${req.id}/decision`, headers: as('analyst.two'), payload: { decision: 'reject' } });
    expect(again.statusCode).toBe(409);
  });

  it('keeps a reorder rejected by an analyst, and refuses an unknown request', async () => {
    await app.inject({ method: 'POST', url: `/api/assets/${diesel}/reorders`, headers: as('ops.power'), payload: { quantity: 2, reason: 'top-up' } });
    const pending = (await app.inject({ method: 'GET', url: '/api/reorders?', headers: as('analyst.two') })).json().find((r: { status: string; quantity: number }) => r.status === 'requested' && r.quantity === 2);
    const rejected = await app.inject({ method: 'POST', url: `/api/reorders/${pending.id}/decision`, headers: as('analyst.two'), payload: { decision: 'reject', note: 'not needed' } });
    expect(rejected.json()).toMatchObject({ status: 'rejected' });
    const unknown = await app.inject({ method: 'POST', url: '/api/reorders/reo-missing/decision', headers: as('analyst.two'), payload: { decision: 'approve' } });
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses a reorder for a record that is not a supply item', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/assets/${ups}/reorders`, headers: as('ops.power'), payload: { quantity: 1, reason: 'no' } });
    expect(r.statusCode).toBe(400);
  });
});
