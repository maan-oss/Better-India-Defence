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
 * Documents: ingestion checks, attribution in search results, excerpts, results limited by clearance and organisation,
 * and an assessment that someone other than the uploader makes.
 */
const PASSWORD = 'Kestrel-7-Orbit-mapping';
let dir: string;
let platform: Platform;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const as = (who: string) => ({ cookie: cookies[who]! });
let fuel: string;
let count: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-docs-'));
  const cfg = loadConfig({ NODE_ENV: 'test', STRATA_MODE: 'operational', STRATA_MFA_REQUIRED: 'false', DATA_DIR: dir, STRATA_ADMIN_PASSWORD: PASSWORD, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
  platform = new Platform(cfg, createLogger('error', false));
  await platform.start();
  const a = platform.auth;
  await a.create('ops.logistics', 'Logistics Operator', 'operator', PASSWORD, { clearance: 'CONFIDENTIAL', organisation: 'logistics' });
  await a.create('ops.plain', 'Plain Operator', 'operator', PASSWORD, { clearance: 'UNCLASSIFIED', organisation: 'logistics' });
  await a.create('analyst.logistics', 'Logistics Analyst', 'analyst', PASSWORD, { clearance: 'CONFIDENTIAL', organisation: 'logistics' });
  await a.create('viewer.site', 'Site Viewer', 'viewer', PASSWORD, { clearance: 'UNCLASSIFIED', organisation: 'site' });
  app = await buildApp(platform);
  for (const who of ['ops.logistics', 'ops.plain', 'analyst.logistics', 'viewer.site']) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: who, password: PASSWORD } });
    cookies[who] = String(r.headers['set-cookie']).split(';')[0]!;
  }
  const upload = (who: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/documents', headers: as(who), payload });
  fuel = (await upload('ops.logistics', { title: 'Fuel delivery note', source: 'Supplier email 2026-10-12', kind: 'text', text: 'Diesel delivery scheduled for Tuesday. The diesel stock reorder was approved by the analyst.', documentDate: 1_728_000_000_000 })).json().id;
  count = (await upload('ops.logistics', { title: 'Stock count', source: 'Store audit', kind: 'csv', text: 'item,qty\ndiesel,1400\nfilters,12\n', classification: 'RESTRICTED' })).json().id;
  await upload('ops.logistics', { title: 'Patrol log', source: 'Gate patrol', kind: 'markdown', text: '# Patrol log\n- North gate: sensor cable fault, reported to the duty officer' });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const search = (who: string, q: string) => app.inject({ method: 'GET', url: `/api/documents/search?q=${encodeURIComponent(q)}`, headers: as(who) });

describe('ingestion', () => {
  it('refuses a ragged CSV, binary data, and a classification above the uploader\'s clearance, with the reasons', async () => {
    const ragged = await app.inject({ method: 'POST', url: '/api/documents', headers: as('ops.logistics'), payload: { title: 'Bad', source: 'test', kind: 'csv', text: 'a,b\n1,2,3\n' } });
    expect(ragged.statusCode).toBe(400);
    expect(ragged.json().problems).toEqual(['row 2 has 3 fields; the header has 2']);
    const binary = await app.inject({ method: 'POST', url: '/api/documents', headers: as('ops.logistics'), payload: { title: 'Bin', source: 'test', kind: 'text', text: 'abc\u0000' } });
    expect(binary.statusCode).toBe(400);
    const high = await app.inject({ method: 'POST', url: '/api/documents', headers: as('ops.plain'), payload: { title: 'Top', source: 'test', kind: 'text', text: 'x', classification: 'SECRET' } });
    expect(high.statusCode).toBe(403);
  });

  it('records who loaded each document, from where, and when', async () => {
    const d = (await app.inject({ method: 'GET', url: `/api/documents/${fuel}`, headers: as('ops.logistics') })).json();
    expect(d).toMatchObject({ uploadedBy: 'ops.logistics', source: 'Supplier email 2026-10-12', documentDate: 1_728_000_000_000, kind: 'text', confidence: 'unreviewed' });
    expect(typeof d.uploadedAt).toBe('number');
  });
});

describe('search', () => {
  it('finds the words in the body with an excerpt that marks them, and names the source and uploader', async () => {
    const hits = (await search('ops.logistics', 'diesel')).json() as { id: string; source: string; uploadedBy: string; excerpt: string; title: string }[];
    expect(hits.map((h) => h.title).sort()).toEqual(['Fuel delivery note', 'Stock count']);
    const fuelHit = hits.find((h) => h.id === fuel)!;
    expect(fuelHit.excerpt).toContain('[[diesel]]');
    expect(fuelHit.source).toBe('Supplier email 2026-10-12');
    expect(fuelHit.uploadedBy).toBe('ops.logistics');
  });

  it('ranks a match in the title above one in the body', async () => {
    const hits = (await search('ops.logistics', 'stock')).json() as { title: string }[];
    expect(hits[0]!.title).toBe('Stock count');
  });

  it('shows a person only the documents their clearance and organisation reach', async () => {
    expect(((await search('ops.plain', 'diesel')).json() as unknown[]).length).toBe(1);
    expect(((await search('ops.plain', 'filters')).json() as unknown[]).length).toBe(0);
    expect(((await search('viewer.site', 'diesel')).json() as unknown[]).length).toBe(0);
    expect(((await search('analyst.logistics', 'filters')).json() as unknown[]).length).toBe(1);
  });

  it('answers an unknown document as unknown, and an empty query with the recent documents the person may see', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/documents/${count}`, headers: as('ops.plain') })).statusCode).toBe(404);
    const recent = (await search('ops.plain', '')).json() as unknown[];
    expect(recent.length).toBe(2);
  });
});

describe('assessment', () => {
  it('lets an analyst who did not upload a document set its confidence, which then shows in search', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/api/documents/${fuel}/confidence`, headers: as('analyst.logistics'), payload: { confidence: 'confirmed', note: 'Matches the delivery docket' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ confidence: 'confirmed', confidenceBy: 'analyst.logistics', confidenceNote: 'Matches the delivery docket' });
    const hit = ((await search('ops.logistics', 'diesel')).json() as { id: string; confidence: string }[]).find((h) => h.id === fuel)!;
    expect(hit.confidence).toBe('confirmed');
  });

  it('refuses an uploader assessing their own document, and an operator who lacks the permission', async () => {
    const own = await app.inject({ method: 'PATCH', url: `/api/documents/${fuel}/confidence`, headers: as('ops.logistics'), payload: { confidence: 'confirmed' } });
    expect(own.statusCode).toBe(403);
    const operator = await app.inject({ method: 'PATCH', url: `/api/documents/${fuel}/confidence`, headers: as('ops.plain'), payload: { confidence: 'disputed' } });
    expect(operator.statusCode).toBe(403);
  });
});
