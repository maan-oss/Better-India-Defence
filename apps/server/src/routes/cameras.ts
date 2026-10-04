import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Platform } from '../platform.ts';
import { audit, parse, requirePerm } from '../http/guards.ts';
import { CameraError, CameraSourceInput, maskUrl } from '../cameras/cameraService.ts';
import { EvidenceError } from '../evidence/evidenceService.ts';

export function registerCameras(app: FastifyInstance, p: Platform): void {
  app.get('/api/cameras', { preHandler: requirePerm('media.view') }, async () => ({ sources: await p.cameras.list(), siteCameras: p.cameras.siteCameras(), ffmpeg: p.vision.ffmpeg }));

  app.get('/api/cameras/import-files', { preHandler: requirePerm('cameras.manage') }, async () => {
    const dir = p.cameras.importDir;
    const out: { name: string; bytes: number }[] = [];
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const s = await stat(join(dir, f)).catch(() => null);
      if (s?.isFile()) out.push({ name: f, bytes: s.size });
    }
    return { dir, files: out };
  });

  app.post('/api/cameras', { preHandler: requirePerm('cameras.manage') }, async (req, reply) => {
    const b = parse(CameraSourceInput, req.body, reply);
    if (!b) return;
    try {
      const r = await p.cameras.upsert(b, req.user!.username);
      await audit(p, req, 'camera_source_saved', b.id, { ...b, url: b.url ? maskUrl(b.url) : '(unchanged)' });
      return r;
    } catch (e) {
      if (e instanceof CameraError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/cameras/test', { preHandler: requirePerm('cameras.manage') }, async (req, reply) => {
    const b = parse(z.object({ url: z.string().min(4).max(1000) }), req.body, reply);
    if (!b) return;
    if (!p.vision.ffmpeg) return reply.code(503).send({ error: 'ffmpeg is not installed on the server' });
    try {
      return await p.cameras.test(b.url);
    } catch (e) {
      if (e instanceof CameraError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post('/api/cameras/:id/enable', { preHandler: requirePerm('cameras.manage') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(z.object({ enabled: z.boolean() }), req.body, reply);
    if (!b) return;
    const r = await p.cameras.setEnabled(id, b.enabled);
    if (!r) return reply.code(404).send({ error: 'unknown camera source' });
    await audit(p, req, b.enabled ? 'camera_source_enabled' : 'camera_source_disabled', id, {});
    return r;
  });

  app.delete('/api/cameras/:id', { preHandler: requirePerm('cameras.manage') }, async (req) => {
    const id = (req.params as { id: string }).id;
    await p.cameras.remove(id);
    await audit(p, req, 'camera_source_removed', id, {});
    return { ok: true };
  });

  /** Frames from a device camera: a signed-in phone, tablet or laptop streaming its own camera (JPEG body). */
  app.post('/api/cameras/:id/frame', { preHandler: requirePerm('ops.log'), bodyLimit: 6 * 1024 * 1024, config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!(req.body instanceof Buffer)) return reply.code(415).send({ error: 'send the frame as image/jpeg' });
    try {
      p.cameras.pushFrame((req.params as { id: string }).id, new Uint8Array(req.body));
      return reply.code(204).send();
    } catch (e) {
      return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.get('/api/cameras/:id/snapshot', { preHandler: requirePerm('media.view') }, async (req, reply) => {
    const l = p.cameras.latest((req.params as { id: string }).id);
    if (!l) return reply.code(404).send({ error: 'no live frame' });
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'no-store').header('x-frame-time', String(l.at)).send(Buffer.from(l.jpeg));
  });

  /** Live view as multipart MJPEG (works in an <img> tag; no plugins, no transcoding). */
  app.get('/api/cameras/:id/mjpeg', { preHandler: requirePerm('media.view') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const first = p.cameras.latest(id);
    const boundary = 'strataframe';
    let unsub: (() => void) | null = null;
    const send = (jpeg: Uint8Array) => {
      if (reply.raw.writableLength > 4 * 1024 * 1024) return; // slow client: skip frames
      reply.raw.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.byteLength}\r\n\r\n`);
      reply.raw.write(Buffer.from(jpeg));
      reply.raw.write('\r\n');
    };
    unsub = p.cameras.subscribe(id, send);
    if (!unsub) return reply.code(404).send({ error: 'camera source not running' });
    await audit(p, req, 'camera_live_view', id, {});
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': `multipart/x-mixed-replace; boundary=${boundary}`, 'cache-control': 'no-store', connection: 'close', 'x-content-type-options': 'nosniff' });
    if (first) send(first.jpeg);
    req.raw.on('close', () => unsub?.());
  });

  app.post('/api/cameras/:id/capture', { preHandler: requirePerm('evidence.upload') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(z.object({ note: z.string().max(2000).nullish() }), req.body ?? {}, reply);
    if (!b) return;
    try {
      const r = await p.cameras.capture(id, { username: req.user!.username, role: req.user!.role, ip: req.ip }, b.note ?? null);
      await audit(p, req, 'camera_frame_captured', r.item.id, { camera: id });
      return reply.code(201).send(r);
    } catch (e) {
      if (e instanceof CameraError || e instanceof EvidenceError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
}
