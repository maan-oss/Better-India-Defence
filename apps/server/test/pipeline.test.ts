import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatorEngine } from '@strata/simulator';
import { INGEST_SCHEMA_VERSION } from '@strata/domain';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';
import type { FastifyInstance } from 'fastify';

/**
 * Vertical integration: simulator traffic → ingestion API → normalisation → fusion → PostgreSQL (embedded)
 * → alerts → replay queries → authenticated HTTP API. Runs against a real PostgreSQL engine (PGlite).
 */
let dir: string;
let platform: Platform;
let app: FastifyInstance;
const TOKEN = 'test-service-token-0123456789';
const t0 = Date.UTC(2026, 9, 4, 6, 0, 0);
let cookie = '';

async function ingest(messages: unknown[]) {
  const res = await app.inject({ method: 'POST', url: '/api/ingest/batch', headers: { authorization: `Bearer ${TOKEN}` }, payload: { messages } });
  return { status: res.statusCode, body: res.json() as { accepted: number; duplicates: number; rejected: { reason: string }[] } };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-test-'));
  const cfg = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, STRATA_SERVICE_TOKEN: TOKEN, SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
  platform = new Platform(cfg, createLogger('error', false));
  await platform.start();
  app = await buildApp(platform);
  // Replay 4 minutes of the UNIDENTIFIED_DRONE scenario through the HTTP ingestion API.
  const engine = new SimulatorEngine([{ id: 'x', key: 'UNIDENTIFIED_DRONE', t0: t0 + 60_000, source: 'recording' }]);
  for (let t = t0; t <= t0 + 9 * 60_000; t += 1000) {
    const out = engine.step(t);
    const msgs = out.messages.filter((m) => m.kind !== 'lidar.scan' && m.kind !== 'imagery.capture');
    if (msgs.length) await ingest(msgs);
  }
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'analyst', password: 'strata-demo' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('ingestion → fusion → persistence', () => {
  it('fuses radar + RF evidence on the unidentified drone into one track and raises an alert', async () => {
    const rows = (await platform.db.query<{ id: string; contributors: { sensorId: string }[]; cooperative: boolean; category: string }>(`SELECT id, contributors, cooperative, category FROM tracks WHERE category = 'aerial' AND NOT cooperative`)).rows;
    const fused = rows.find((r) => r.contributors.some((c) => c.sensorId.startsWith('R0')) && r.contributors.some((c) => c.sensorId.startsWith('RF')));
    expect(fused).toBeDefined();
    const alerts = (await platform.db.query<{ rule: string }>(`SELECT rule FROM alerts`)).rows.map((r) => r.rule);
    expect(alerts).toContain('UNIDENTIFIED_AERIAL');
  });

  it('persists track history that replay can reproduce', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/replay/tracks?from=${t0 + 120_000}&to=${t0 + 300_000}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const w = res.json() as { tracks: { id: string; samples: number[] }[] };
    expect(w.tracks.length).toBeGreaterThan(5);
    expect(w.tracks.some((t) => t.samples.length >= 8 * 10)).toBe(true);
  });

  it('tracks cooperative personnel from GPS', async () => {
    const n = (await platform.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tracks WHERE cooperative AND category = 'person'`)).rows[0]!.n;
    expect(n).toBeGreaterThan(5);
  });
});

describe('ingestion robustness', () => {
  const base = (id: string, observedAt: number) => ({
    schema: INGEST_SCHEMA_VERSION,
    messageId: id,
    sensorId: 'BMS1',
    adapter: 'bms.test.v1',
    seq: 1,
    observedAt,
    sentAt: observedAt,
    kind: 'infrastructure.state',
    payload: { assetId: 'gate-N', assetKind: 'gate', state: 'closed', alarm: false },
  });

  it('de-duplicates by message id', async () => {
    const m = base('dup-test-0001', Date.now() - 1000);
    const a = await ingest([m]);
    const b = await ingest([m, m]);
    expect(a.body.accepted).toBe(1);
    expect(b.body.accepted).toBe(0);
    expect(b.body.duplicates).toBe(2);
  });

  it('rejects future and ancient timestamps, schema violations and unregistered sensors into dead letters', async () => {
    const r = await ingest([base('future-0001', Date.now() + 3600_000), base('ancient-0001', Date.UTC(1999, 0, 1)), { ...base('bad-schema-1', Date.now()), payload: { garbage: true } }, { ...base('unreg-00001', Date.now()), sensorId: 'ZZ99' }]);
    expect(r.status).toBe(207);
    expect(r.body.rejected).toHaveLength(4);
    const n = (await platform.db.query<{ n: number }>('SELECT count(*)::int AS n FROM dead_letters')).rows[0]!.n;
    expect(n).toBeGreaterThanOrEqual(4);
  });

  it('requires the service token for ingestion', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ingest/batch', payload: { messages: [base('noauth-0001', Date.now())] } });
    expect(res.statusCode).toBe(401);
  });
});

describe('security', () => {
  it('enforces role-based access', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'viewer', password: 'strata-demo' } });
    const vcookie = String(login.headers['set-cookie']).split(';')[0]!;
    const denied = await app.inject({ method: 'POST', url: '/api/handoff/search', headers: { cookie: vcookie }, payload: { subjectId: 'x', from: 0, to: 1, purpose: 'test' } });
    expect(denied.statusCode).toBe(403);
    const anon = await app.inject({ method: 'GET', url: '/api/alerts' });
    expect(anon.statusCode).toBe(401);
  });

  it('keeps an append-only, verifiable audit chain', async () => {
    await app.inject({ method: 'GET', url: `/api/tracks/A-101?t=${t0 + 300_000}`, headers: { cookie } });
    const v = await app.inject({ method: 'GET', url: '/api/audit/verify', headers: { cookie } });
    expect(v.json()).toMatchObject({ ok: true });
    await expect(platform.db.query(`UPDATE audit_events SET actor = 'mallory'`)).rejects.toThrow(/append-only/);
    await expect(platform.db.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
  });
});

describe('copilot', () => {
  it('answers from the record with evidence and refuses to guess', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/copilot/query', headers: { cookie }, payload: { text: 'Which sensors stopped reporting before this incident?', t: t0 + 300_000 } });
    expect(r.statusCode).toBe(200);
    const unknown = await app.inject({ method: 'POST', url: '/api/copilot/query', headers: { cookie }, payload: { text: 'make me a sandwich', t: t0 + 300_000 } });
    const body = unknown.json() as { intent: string; insufficient: string | null };
    expect(body.intent).toBe('unknown');
    expect(body.insufficient).not.toBeNull();
  });
});
