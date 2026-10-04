import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { INGEST_SCHEMA_VERSION } from '@strata/domain';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';
import { findModelsDir } from '../src/vision/engine.ts';

/**
 * Live camera path: a recorded feed played as a live camera (ffmpeg -re -stream_loop) → frame grabbing →
 * vision worker → camera.detections through the ingest pipeline → tracks; faces → recognition with zone
 * authorisation → alerts; live frame capture into the evidence library.
 */
const fixtures = resolve(import.meta.dirname, 'fixtures');
const ready = spawnSync('ffmpeg', ['-version']).status === 0 && ['face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec.onnx', 'object_detection_yolox_2022nov.onnx'].every((f) => existsSync(join(findModelsDir(), f)));

let dir: string;
let platform: Platform;
let app: FastifyInstance;
let cookie = '';
const H = () => ({ cookie });

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe.skipIf(!ready)('live cameras (requires ffmpeg and models)', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'strata-cam-'));
    mkdirSync(join(dir, 'import'), { recursive: true });
    // A 6 s "gate camera" recording: the CCTV composite with slight drift and noise.
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', join(fixtures, 'subject-a-cctv.jpg'), '-t', '6', '-vf', "crop=1200:680:x='20+t*4':y=20,noise=alls=6:allf=t,fps=10", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'import', 'gate2.mp4')]);
    expect(r.status).toBe(0);
    const cfg = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
    platform = new Platform(cfg, createLogger('error', false));
    await platform.start();
    app = await buildApp(platform);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'strata-demo' } });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
    // Authorised officer, cleared for the operations area only.
    const id = (await app.inject({ method: 'POST', url: '/api/identities', headers: H(), payload: { list: 'AUTHORISED', category: 'Personnel', name: 'Test Officer A', accessZones: ['zn-ops'] } })).json() as { id: string };
    const faces = (await app.inject({ method: 'POST', url: '/api/vision/faces', headers: { ...H(), 'content-type': 'image/jpeg' }, payload: (await import('node:fs')).readFileSync(join(fixtures, 'subject-a.jpg')) })).json() as { token: string };
    await app.inject({ method: 'POST', url: `/api/identities/${id.id}/templates`, headers: H(), payload: { token: faces.token, faceIndex: 0 } });
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await platform?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses file sources outside the import directory and unsupported schemes', async () => {
    const outside = await app.inject({ method: 'POST', url: '/api/cameras', headers: H(), payload: { id: 'BAD-1', name: 'x', binding: 'new', url: '/etc/passwd', pose: { lat: 0, lon: 0, heightM: 5, headingDeg: 0, pitchDeg: -10, hfovDeg: 60 } } });
    expect(outside.statusCode).toBe(400);
    const scheme = await app.inject({ method: 'POST', url: '/api/cameras', headers: H(), payload: { id: 'BAD-2', name: 'x', binding: 'new', url: 'gopher://x', pose: { lat: 0, lon: 0, heightM: 5, headingDeg: 0, pitchDeg: -10, hfovDeg: 60 } } });
    expect(scheme.statusCode).toBe(400);
  });

  it('runs a recorded feed as a live camera: frames, detections into fusion, recognition with zone authorisation, capture to evidence', async () => {
    const saved = await app.inject({
      method: 'POST',
      url: '/api/cameras',
      headers: H(),
      payload: { id: 'GATE2-CAM1', name: 'Gate 2 entry', binding: 'new', url: 'gate2.mp4', loopFile: true, pose: { lat: 0.0004, lon: 0.0004, heightM: 6, headingDeg: 200, pitchDeg: -12, hfovDeg: 70 }, zoneId: 'zn-secure', analyticsFps: 2 },
    });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as { urlMasked: string }).urlMasked).toContain('gate2.mp4');
    // Live frames arrive.
    await until(async () => (await app.inject({ method: 'GET', url: '/api/cameras/GATE2-CAM1/snapshot', headers: H() })).statusCode === 200);
    // Detections flow through the standard ingest pipeline as observations of the new sensor.
    await until(async () => (await platform.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM observations WHERE sensor_id = 'GATE2-CAM1' AND kind = 'track'`)).rows[0]!.n > 5);
    // The officer is recognised and, being outside their authorised zones, raises an alert.
    const ev = await until(async () => {
      const r = (await app.inject({ method: 'GET', url: '/api/faces?source=GATE2-CAM1', headers: H() })).json() as { decision: string; zoneId: string; alertId: string | null }[];
      return r.find((x) => x.decision === 'STRONG');
    });
    expect(ev.zoneId).toBe('zn-secure');
    expect(ev.alertId).toBeTruthy();
    const alert = (await platform.db.query<{ rule: string }>('SELECT rule FROM alerts WHERE id = $1', [ev.alertId])).rows[0];
    expect(alert?.rule).toBe('UNAUTHORISED_ZONE_ACCESS');
    // Status reflects a live, analysed stream.
    const list = (await app.inject({ method: 'GET', url: '/api/cameras', headers: H() })).json() as { sources: { id: string; status: { state: string; framesAnalysed: number } }[] };
    const st = list.sources.find((s) => s.id === 'GATE2-CAM1')!.status;
    expect(st.state).toBe('live');
    expect(st.framesAnalysed).toBeGreaterThan(0);
    // Capture the live frame into the evidence library.
    const cap = await app.inject({ method: 'POST', url: '/api/cameras/GATE2-CAM1/capture', headers: H(), payload: { note: 'test capture' } });
    expect(cap.statusCode).toBe(201);
    expect((cap.json() as { item: { source: string; capturedAtBasis: string } }).item.source).toBe('GATE2-CAM1');
  }, 120_000);

  it('a live source bound to a site camera supersedes its simulated analytics', async () => {
    await app.inject({ method: 'POST', url: '/api/cameras', headers: H(), payload: { id: 'C05', name: 'C05 live', binding: 'site', url: 'gate2.mp4', loopFile: true, recogniseFaces: false } });
    const sim = {
      schema: INGEST_SCHEMA_VERSION,
      messageId: `sim-c05-${Date.now()}`,
      sensorId: 'C05',
      adapter: 'vms.onvif-analytics-bridge.v1',
      seq: 1,
      observedAt: Date.now(),
      sentAt: Date.now(),
      kind: 'camera.detections',
      payload: { frameId: 'f', pose: { position: { lat: 0, lon: 0, alt: 10 }, headingDeg: 0, pitchDeg: -10, hfovDeg: 60, widthPx: 1920, heightPx: 1080 }, detections: [] },
    };
    const r = await app.inject({ method: 'POST', url: '/api/ingest/batch', headers: { authorization: 'Bearer test-service-token-0123456789' }, payload: { messages: [sim] } });
    expect((r.json() as { superseded?: number }).superseded).toBe(1);
    await app.inject({ method: 'DELETE', url: '/api/cameras/C05', headers: H() });
  }, 60_000);
});
