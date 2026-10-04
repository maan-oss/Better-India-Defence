import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { findSensor, getCameras, getDrones, type CameraDef, type DroneDef } from '@strata/domain';
import type { SimulatorEngine } from './engine.ts';
import { renderFrame } from './render/frame.ts';
import { encodeJpeg } from './render/encode.ts';
import { cameraPoseAt, dronePose } from './sensors/models.ts';
import { SCENARIO_INFO, SCENARIO_KEYS } from './truth/scenarios.ts';
import type { FailureInjector } from './failures.ts';
import type { IngestClient } from './transport.ts';
import type { SimState } from './state.ts';

/**
 * Synthetic video-management system (VMS) + simulator control API.
 *
 * VMS: GET /vms/{cameras|drones}/:id/frame.jpg?t=<epoch ms>  → JPEG rendered from simulator truth at t.
 * This mirrors how a real platform pulls recorded frames from a VMS by timestamp. It refuses future
 * timestamps and times when the camera was offline (there is no recording to return).
 *
 * Control: GET /control/state, POST /control/scenarios, POST /control/failures, POST /control/burst.
 */
export interface ServiceDeps {
  engine: SimulatorEngine;
  failures: FailureInjector;
  client: IngestClient;
  state: SimState;
  token: string;
  persist: () => void;
  liveEdge: () => number;
  log: (m: string) => void;
}

const frameCache = new Map<string, Uint8Array>();
const FRAME_CACHE_MAX = 400;

function authorized(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? '';
  const got = Buffer.from(h.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const scenarioRequest = z.object({ key: z.enum(SCENARIO_KEYS), delayS: z.number().min(0).max(3600).default(5) });
const failureRequest = z.object({
  duplicateRate: z.number().min(0).max(1).optional(),
  outOfOrderRate: z.number().min(0).max(1).optional(),
  badTimestampRate: z.number().min(0).max(1).optional(),
  corruptRate: z.number().min(0).max(1).optional(),
  latencyMs: z.number().min(0).max(120_000).optional(),
  disconnectForS: z.number().min(0).max(600).optional(),
  contradictGpsForS: z.number().min(0).max(600).optional(),
  malformedJson: z.boolean().optional(),
});

export function startService(port: number, deps: ServiceDeps): void {
  const server = createServer((req, res) => {
    void handle(req, res, deps).catch((e: unknown) => {
      deps.log(`service error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  });
  server.listen(port, () => deps.log(`VMS + control API listening on :${port}`));
}

async function handle(req: IncomingMessage, res: ServerResponse, d: ServiceDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') return json(res, 200, { ok: true });
  if (!authorized(req, d.token)) return json(res, 401, { error: 'unauthorized' });

  const frameMatch = /^\/vms\/(cameras|drones)\/([A-Z0-9-]+)\/frame\.jpg$/.exec(url.pathname);
  if (req.method === 'GET' && frameMatch) {
    const id = frameMatch[2]!;
    const tRaw = Number(url.searchParams.get('t'));
    if (!Number.isFinite(tRaw)) return json(res, 400, { error: 't (epoch ms) required' });
    const t = Math.round(tRaw / 500) * 500;
    if (t > d.liveEdge() + 1000) return json(res, 416, { error: 'requested time is in the future; no recording exists' });
    const sensor = findSensor(id);
    if (!sensor || (sensor.kind !== 'camera' && sensor.kind !== 'drone')) return json(res, 404, { error: 'unknown camera' });
    const outage = d.engine.world.outage(id, t);
    if (outage?.kind === 'offline') return json(res, 410, { error: `no recording: ${id} offline (${outage.reason})` });
    const key = `${id}:${t}`;
    let jpg = frameCache.get(key);
    if (!jpg) {
      if (sensor.kind === 'camera') {
        const cam = getCameras().find((c) => c.id === id) as CameraDef;
        jpg = encodeJpeg(renderFrame(d.engine.world, cameraPoseAt(cam, t), t, { label: cam.id, rangeM: cam.rangeM }), cam.widthPx, cam.heightPx);
      } else {
        const drone = getDrones().find((c) => c.id === id) as DroneDef;
        const s = d.engine.world.droneState(id, t);
        if (!s || s.mode === 'docked') return json(res, 410, { error: `no recording: ${id} not airborne at requested time` });
        const pose = dronePose(drone, s);
        jpg = encodeJpeg(renderFrame(d.engine.world, pose, t, { label: drone.id, rangeM: 700, excludeEntityId: `uas-${id}` }), pose.widthPx, pose.heightPx);
      }
      frameCache.set(key, jpg);
      if (frameCache.size > FRAME_CACHE_MAX) frameCache.delete(frameCache.keys().next().value as string);
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400', 'x-frame-time': String(t) });
    res.end(Buffer.from(jpg));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/control/state') {
    return json(res, 200, {
      liveEdge: d.liveEdge(),
      recordingStart: d.state.recordingStart,
      recordingEnd: d.state.recordingEnd,
      schedule: d.state.schedule,
      scenarios: SCENARIO_INFO,
      failures: d.failures.config,
      failureCounters: d.failures.counters,
      transport: { queued: d.client.queued, sent: d.client.sent, dropped: d.client.dropped, failures: d.client.failures, connected: d.client.connected, lastError: d.client.lastError },
      engine: d.engine.stats,
    });
  }
  if (req.method === 'POST' && url.pathname === '/control/scenarios') {
    const body = scenarioRequest.safeParse(await readBody(req));
    if (!body.success) return json(res, 400, { error: body.error.issues.map((i) => i.message).join('; ') });
    const entry = { id: `op-${Date.now()}`, key: body.data.key, t0: Math.ceil((d.liveEdge() + body.data.delayS * 1000) / 1000) * 1000, source: 'operator' as const };
    d.state.schedule.push(entry);
    d.engine.world.add(entry);
    d.persist();
    d.log(`scenario ${entry.key} scheduled at ${new Date(entry.t0).toISOString()}`);
    return json(res, 201, entry);
  }
  if (req.method === 'POST' && url.pathname === '/control/failures') {
    const body = failureRequest.safeParse(await readBody(req));
    if (!body.success) return json(res, 400, { error: body.error.issues.map((i) => i.message).join('; ') });
    const b = body.data;
    const c = d.failures.config;
    if (b.duplicateRate !== undefined) c.duplicateRate = b.duplicateRate;
    if (b.outOfOrderRate !== undefined) c.outOfOrderRate = b.outOfOrderRate;
    if (b.badTimestampRate !== undefined) c.badTimestampRate = b.badTimestampRate;
    if (b.corruptRate !== undefined) c.corruptRate = b.corruptRate;
    if (b.latencyMs !== undefined) c.latencyMs = b.latencyMs;
    if (b.disconnectForS) c.disconnectedUntil = Date.now() + b.disconnectForS * 1000;
    if (b.contradictGpsForS) d.engine.contradiction = { entityId: 'per-01', dx: 420, dy: -310, until: d.liveEdge() + b.contradictGpsForS * 1000 };
    let malformedStatus: number | null = null;
    if (b.malformedJson) malformedStatus = await d.client.sendRaw('{"schema":"strata.ingest/v1","messageId":').catch(() => -1);
    return json(res, 200, { failures: c, malformedStatus });
  }
  if (req.method === 'POST' && url.pathname === '/control/burst') {
    const body = z.object({ count: z.number().int().min(1).max(50_000) }).safeParse(await readBody(req));
    if (!body.success) return json(res, 400, { error: 'count 1..50000 required' });
    const t = d.liveEdge();
    const msgs = Array.from({ length: body.data.count }, (_, i) => ({
      schema: 'strata.ingest/v1',
      messageId: `BURST-${t}-${i}`,
      sensorId: 'BMS1',
      adapter: 'bms.modbus-gateway.v1',
      seq: Math.floor(t / 100) * 16 + 15,
      observedAt: t,
      sentAt: t,
      kind: 'infrastructure.state',
      payload: { assetId: 'gate-N', assetKind: 'gate', state: 'closed', alarm: false, detail: 'burst test' },
    }));
    d.client.enqueue(msgs);
    return json(res, 202, { enqueued: msgs.length });
  }
  if (url.pathname === '/control/sensor' && req.method === 'GET') {
    const id = url.searchParams.get('id') ?? '';
    return json(res, 200, { id, sensor: findSensor(id) ?? null });
  }
  json(res, 404, { error: 'not found' });
}
