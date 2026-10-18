import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';

/** The integration monitor: deliveries per sensor and refusals by reason, inside a window, for people who may view the system. */
const PASSWORD = 'Kestrel-7-Orbit-mapping';
let dir: string;
let platform: Platform;
let app: FastifyInstance;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'strata-monitor-'));
  const cfg = loadConfig({ NODE_ENV: 'test', STRATA_MODE: 'operational', STRATA_MFA_REQUIRED: 'false', DATA_DIR: dir, STRATA_ADMIN_PASSWORD: PASSWORD, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
  platform = new Platform(cfg, createLogger('error', false));
  await platform.start();
  await platform.auth.create('viewer.one', 'Viewer', 'viewer', PASSWORD);
  await platform.auth.create('operator.one', 'Operator', 'operator', PASSWORD);
  app = await buildApp(platform);
  for (const who of ['viewer.one', 'operator.one']) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: who, password: PASSWORD } });
    cookies[who] = String(r.headers['set-cookie']).split(';')[0]!;
  }
  const now = Date.now();
  const hour = 3_600_000;
  for (let i = 0; i < 3; i++) await platform.db.query('INSERT INTO ingest_messages (message_id, sensor_id, received_at) VALUES ($1,$2,$3)', [`m-gps-${i}`, 'GPS1', now - i * 1000]);
  await platform.db.query('INSERT INTO ingest_messages (message_id, sensor_id, received_at) VALUES ($1,$2,$3)', ['m-old', 'GPS1', now - 30 * hour]);
  await platform.db.query('INSERT INTO ingest_messages (message_id, sensor_id, received_at) VALUES ($1,$2,$3)', ['m-radar', 'R01', now - 5000]);
  await platform.db.query('INSERT INTO dead_letters (received_at, reason, sensor_id, message_id, raw) VALUES ($1,$2,$3,$4,$5)', [now - 1000, 'unknown sensor', 'X99', 'd1', '{}']);
  await platform.db.query('INSERT INTO dead_letters (received_at, reason, sensor_id, message_id, raw) VALUES ($1,$2,$3,$4,$5)', [now - 2000, 'unknown sensor', 'X99', 'd2', '{}']);
  await platform.db.query('INSERT INTO dead_letters (received_at, reason, sensor_id, message_id, raw) VALUES ($1,$2,$3,$4,$5)', [now - 3000, 'timestamp out of bounds', null, 'd3', '{}']);
  await platform.db.query('INSERT INTO dead_letters (received_at, reason, sensor_id, message_id, raw) VALUES ($1,$2,$3,$4,$5)', [now - 31 * hour, 'unknown sensor', 'X99', 'd-old', '{}']);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await platform?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('integration monitor', () => {
  it('counts what each sensor delivered in the window, most active first, and nothing older than it', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/interop/monitor', headers: { cookie: cookies['operator.one']! } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.sensors.map((s: { sensorId: string; messages: number }) => [s.sensorId, s.messages])).toEqual([
      ['GPS1', 3],
      ['R01', 1],
    ]);
    expect(body.totals).toEqual({ messages: 4, deadLetters: 3 });
  });

  it('groups refused messages by reason and by sensor, with the last time each was seen', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/interop/monitor?hours=24', headers: { cookie: cookies['operator.one']! } })).json();
    expect(body.deadLettersByReason.map((r: { reason: string; count: number }) => [r.reason, r.count])).toEqual([
      ['unknown sensor', 2],
      ['timestamp out of bounds', 1],
    ]);
    expect(body.deadLettersBySensor.map((s: { sensorId: string; count: number }) => [s.sensorId, s.count])).toEqual([
      ['X99', 2],
      ['(none)', 1],
    ]);
    const wider = (await app.inject({ method: 'GET', url: '/api/interop/monitor?hours=48', headers: { cookie: cookies['operator.one']! } })).json();
    expect(wider.totals.deadLetters).toBe(4);
  });

  it('refuses a window outside the bounds, and refuses a person without the system permission', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/interop/monitor?hours=500', headers: { cookie: cookies['operator.one']! } });
    expect(bad.statusCode).toBe(400);
    const viewer = await app.inject({ method: 'GET', url: '/api/interop/monitor', headers: { cookie: cookies['viewer.one']! } });
    expect(viewer.statusCode).toBe(403);
    const anon = await app.inject({ method: 'GET', url: '/api/interop/monitor' });
    expect(anon.statusCode).toBe(401);
  });
});
