import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { Platform } from '../src/platform.ts';
import { buildApp } from '../src/app.ts';
import { findModelsDir } from '../src/vision/engine.ts';

/**
 * Vision end-to-end through the HTTP API with the real models: evidence intake, object/face analysis,
 * enrolment, watchlist rules, review, retrospective search, enhancement provenance, video analysis.
 * Faces are synthetic (people who do not exist) — see test/fixtures/README.md.
 */
const fx = (n: string) => readFileSync(resolve(import.meta.dirname, 'fixtures', n));
const modelsReady = ['object_detection_yolox_2022nov.onnx', 'face_detection_yunet_2023mar.onnx', 'face_recognition_sface_2021dec.onnx', 'esrgan_general_x4v3.onnx'].every((f) => existsSync(join(findModelsDir(), f)));
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

let dir: string;
let platform: Platform;
let app: FastifyInstance;
const cookies: Record<string, string> = {};

async function login(u: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: 'strata-demo' } });
  cookies[u] = String(r.headers['set-cookie']).split(';')[0]!;
}
const as = (u: string) => ({ cookie: cookies[u]! });

async function upload(u: string, bytes: Buffer, title: string, extra = '') {
  return app.inject({ method: 'POST', url: `/api/evidence/items?title=${encodeURIComponent(title)}${extra}`, headers: { ...as(u), 'content-type': 'application/x-strata-upload' }, payload: bytes });
}

async function waitAnalysed(id: string, ms = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const it = (await app.inject({ method: 'GET', url: `/api/evidence/items/${id}`, headers: as('analyst') })).json() as { analysisStatus: string; analysisError: string | null; analysis: Record<string, unknown> };
    if (it.analysisStatus === 'complete' || it.analysisStatus === 'failed') return it;
    if (Date.now() - t0 > ms) throw new Error('analysis timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(!modelsReady)('vision (requires models: npm run models:fetch)', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'strata-vision-'));
    const cfg = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, STRATA_SERVICE_TOKEN: 'test-service-token-0123456789', SIM_URL: 'http://127.0.0.1:9', LOG_LEVEL: 'error' });
    platform = new Platform(cfg, createLogger('error', false));
    await platform.start();
    app = await buildApp(platform);
    for (const u of ['viewer', 'operator', 'analyst', 'admin']) await login(u);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await platform?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  let identityA = '';
  let identityB = '';
  let cctvItem = '';

  it('reports every model installed and integrity-verified on use', async () => {
    const s = (await app.inject({ method: 'GET', url: '/api/vision/status', headers: as('analyst') })).json() as { models: { key: string; installed: boolean }[] };
    expect(s.models.map((m) => m.key).sort()).toEqual(['detector', 'face_detector', 'face_embedder', 'super_resolution']);
    expect(s.models.every((m) => m.installed)).toBe(true);
  });

  it('ingests an image with its SHA-256, detects people, de-duplicates re-uploads, and enforces upload permission', async () => {
    const denied = await upload('viewer', fx('scene.jpg'), 'scene');
    expect(denied.statusCode).toBe(403);
    const r = await upload('operator', fx('scene.jpg'), 'Court scene');
    expect(r.statusCode).toBe(201);
    const { item } = r.json() as { item: { id: string; sha256: string; kind: string } };
    expect(item.kind).toBe('image');
    expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
    const done = await waitAnalysed(item.id);
    expect(done.analysisStatus).toBe('complete');
    expect((done.analysis.objectCounts as Record<string, number>).person).toBeGreaterThanOrEqual(10);
    const again = await upload('operator', fx('scene.jpg'), 'Court scene (again)');
    expect(again.statusCode).toBe(200);
    expect((again.json() as { duplicate: boolean }).duplicate).toBe(true);
  }, 120_000);

  it('enrols an authorised person from a photo; refuses a watchlist entry without a documented basis', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/identities', headers: as('analyst'), payload: { list: 'AUTHORISED', category: 'Personnel', name: 'Test Subject A', serviceNo: 'IC-00001', rank: 'Maj', unit: 'Test Unit', accessZones: ['zn-ops'] } });
    expect(created.statusCode).toBe(201);
    identityA = (created.json() as { id: string }).id;
    const faces = (await app.inject({ method: 'POST', url: '/api/vision/faces', headers: { ...as('analyst'), 'content-type': 'image/jpeg' }, payload: fx('subject-a.jpg') })).json() as { token: string; faces: { index: number; quality: { grade: string }; usable: boolean }[] };
    expect(faces.faces).toHaveLength(1);
    expect(faces.faces[0]!.quality.grade).toBe('GOOD');
    const enrol = await app.inject({ method: 'POST', url: `/api/identities/${identityA}/templates`, headers: as('analyst'), payload: { token: faces.token, faceIndex: 0 } });
    expect(enrol.statusCode).toBe(201);

    const noBasis = await app.inject({ method: 'POST', url: '/api/identities', headers: as('analyst'), payload: { list: 'WATCHLIST', category: 'Person of interest', name: 'Test Subject B' } });
    expect(noBasis.statusCode).toBe(400);
    const opDenied = await app.inject({ method: 'POST', url: '/api/identities', headers: as('operator'), payload: { list: 'WATCHLIST', category: 'Person of interest', name: 'Test Subject B', basis: 'test' } });
    expect(opDenied.statusCode).toBe(403);
    const wl = await app.inject({ method: 'POST', url: '/api/identities', headers: as('analyst'), payload: { list: 'WATCHLIST', category: 'Person of interest', name: 'Test Subject B', basis: 'Integration test — synthetic identity', threatLevel: 'HIGH' } });
    expect(wl.statusCode).toBe(201);
    identityB = (wl.json() as { id: string }).id;
    const fb = (await app.inject({ method: 'POST', url: '/api/vision/faces', headers: { ...as('analyst'), 'content-type': 'image/jpeg' }, payload: fx('subject-b.jpg') })).json() as { token: string };
    expect((await app.inject({ method: 'POST', url: `/api/identities/${identityB}/templates`, headers: as('analyst'), payload: { token: fb.token, faceIndex: 0 } })).statusCode).toBe(201);
  }, 60_000);

  it('recognises the enrolled person in a degraded CCTV-style capture and ignores faces too small to compare', async () => {
    const r = await upload('operator', fx('subject-a-cctv.jpg'), 'Gate camera export');
    cctvItem = (r.json() as { item: { id: string } }).item.id;
    const done = await waitAnalysed(cctvItem);
    expect(done.analysisStatus).toBe('complete');
    const evs = (await app.inject({ method: 'GET', url: `/api/faces?source=${cctvItem}`, headers: as('analyst') })).json() as { decision: string; bestIdentityId: string | null; bestScore: number; reviewStatus: string }[];
    const matched = evs.filter((e) => e.decision === 'STRONG');
    expect(matched).toHaveLength(1);
    expect(matched[0]!.bestIdentityId).toBe(identityA);
    expect(matched[0]!.bestScore).toBeGreaterThan(0.6);
    expect(matched[0]!.reviewStatus).toBe('NOT_REQUIRED');
    // No other face in the scene may be matched to anyone.
    expect(evs.filter((e) => e.bestIdentityId === identityB && (e.decision === 'STRONG' || e.decision === 'POSSIBLE'))).toHaveLength(0);
  }, 120_000);

  it('a watchlist candidate raises an alert and waits for analyst review; viewers cannot review', async () => {
    const r = await upload('operator', fx('subject-b.jpg'), 'Photo received from local police');
    const id = (r.json() as { item: { id: string } }).item.id;
    await waitAnalysed(id);
    const evs = (await app.inject({ method: 'GET', url: `/api/faces?source=${id}`, headers: as('analyst') })).json() as { id: string; decision: string; reviewStatus: string; alertId: string | null; bestIdentityId: string }[];
    expect(evs).toHaveLength(1);
    expect(evs[0]!.decision).toBe('STRONG');
    expect(evs[0]!.bestIdentityId).toBe(identityB);
    expect(evs[0]!.reviewStatus).toBe('PENDING');
    expect(evs[0]!.alertId).toBeTruthy();
    const alerts = (await platform.db.query<{ rule: string; priority: string }>(`SELECT rule, priority FROM alerts WHERE id = $1`, [evs[0]!.alertId])).rows;
    expect(alerts[0]).toMatchObject({ rule: 'WATCHLIST_CANDIDATE', priority: 'critical' });
    expect((await app.inject({ method: 'POST', url: `/api/faces/${evs[0]!.id}/review`, headers: as('viewer'), payload: { decision: 'CONFIRMED', note: 'looks right' } })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/api/faces/${evs[0]!.id}/review`, headers: as('analyst'), payload: { decision: 'CONFIRMED', note: 'Verified against source photograph' } });
    expect((ok.json() as { reviewStatus: string }).reviewStatus).toBe('CONFIRMED');
  }, 120_000);

  it('retrospective search by identity requires a stated purpose and finds the earlier sighting', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/faces/search', headers: as('analyst'), payload: { identityId: identityA } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/faces/search', headers: as('operator'), payload: { identityId: identityA, purpose: 'trace movements' } })).statusCode).toBe(403);
    const s = (await app.inject({ method: 'POST', url: '/api/faces/search', headers: as('analyst'), payload: { identityId: identityA, purpose: 'Integration test: trace subject A' } })).json() as { results: { sourceId: string; score: number }[] };
    expect(s.results.some((r) => r.sourceId === cctvItem)).toBe(true);
  });

  it('records enhancement provenance: RESTORED for classical operators, AI-INFERRED for generative upscaling (crop-limited)', async () => {
    const restored = await app.inject({ method: 'POST', url: `/api/evidence/items/${cctvItem}/enhance`, headers: as('operator'), payload: { ops: [{ op: 'denoise', strength: 0.6 }, { op: 'clahe', clipLimit: 2, tiles: 8 }] } });
    expect(restored.statusCode).toBe(200);
    const p1 = restored.json() as { state: string; sha256In: string; sha256Out: string; steps: { op: string | { op: string } }[] };
    expect(p1.state).toBe('RESTORED');
    expect(p1.sha256Out).not.toBe(p1.sha256In);
    expect(p1.steps.length).toBe(3);
    const tooBig = await app.inject({ method: 'POST', url: `/api/evidence/items/${cctvItem}/enhance`, headers: as('operator'), payload: { ops: [], aiUpscale: true } });
    expect(tooBig.statusCode).toBe(422);
    const ai = await app.inject({ method: 'POST', url: `/api/evidence/items/${cctvItem}/enhance`, headers: as('operator'), payload: { ops: [{ op: 'crop', x: 800, y: 280, w: 200, h: 200 }], aiUpscale: true } });
    expect(ai.statusCode).toBe(200);
    expect(ai.json()).toMatchObject({ state: 'AI-INFERRED', width: 800, height: 800 });
    const img = await app.inject({ method: 'GET', url: `/api/evidence/products/${(ai.json() as { id: string }).id}/image`, headers: as('viewer') });
    expect(img.headers['x-evidence-state']).toBe('AI-INFERRED');
  }, 120_000);

  it.skipIf(!ffmpeg)('analyses video: one face appearance per person, multi-frame reconstruction from real frames', async () => {
    const out = join(dir, 'clip.mp4');
    const fixtures = resolve(import.meta.dirname, 'fixtures');
    // 4 s clip: the CCTV composite with a slow pan (sub-pixel motion between frames) and sensor noise.
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', join(fixtures, 'subject-a-cctv.jpg'), '-t', '4', '-vf', "crop=1200:680:x='20+t*6':y='20+t*3',noise=alls=8:allf=t,fps=12", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', out]);
    expect(r.status).toBe(0);
    const up = await upload('operator', readFileSync(out), 'Body-worn camera clip');
    expect(up.statusCode).toBe(201);
    const item = (up.json() as { item: { id: string; kind: string; durationS: number } }).item;
    expect(item.kind).toBe('video');
    const done = await waitAnalysed(item.id, 240_000);
    expect(done.analysisStatus).toBe('complete');
    expect(done.analysis.framesAnalysed).toBeGreaterThanOrEqual(7);
    expect(done.analysis.faceAppearances).toBe(1);
    const evs = (await app.inject({ method: 'GET', url: `/api/faces?source=${item.id}`, headers: as('analyst') })).json() as { bestIdentityId: string; decision: string }[];
    expect(evs[0]).toMatchObject({ bestIdentityId: identityA, decision: 'STRONG' });
    const mf = await app.inject({ method: 'POST', url: `/api/evidence/items/${item.id}/multiframe`, headers: as('operator'), payload: { t: 2, roi: { x: 820, y: 300, w: 120, h: 120 }, frames: 10, scale: 3 } });
    expect(mf.statusCode).toBe(200);
    expect(mf.json()).toMatchObject({ state: 'MULTI-OBSERVATION', width: 360, height: 360 });
    expect((mf.json() as { usedFrames: number }).usedFrames).toBeGreaterThanOrEqual(5);
  }, 300_000);

  it('keeps an intact custody trail for evidence actions', async () => {
    const rep = (await app.inject({ method: 'GET', url: `/api/evidence/items/${cctvItem}/report`, headers: as('analyst') })).json() as { custody: { action: string }[]; products: unknown[] };
    const actions = rep.custody.map((c) => c.action);
    expect(actions).toContain('evidence_ingested');
    expect(actions).toContain('evidence_enhanced');
    expect(rep.products.length).toBe(2);
    const v = (await app.inject({ method: 'GET', url: '/api/audit/verify', headers: as('analyst') })).json() as { ok: boolean };
    expect(v.ok).toBe(true);
  });
});
