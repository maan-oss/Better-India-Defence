import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { can } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { audit, parse, requirePerm } from '../http/guards.ts';
import { EvidenceError, MAX_UPLOAD_BYTES } from '../evidence/evidenceService.ts';
import { FaceSettings, IdentityError, IdentityInput, type Identity } from '../identity/identityService.ts';
import type { FaceOut } from '../vision/worker.ts';

const EnhanceOpSchema = z.union([
  z.object({ op: z.literal('denoise'), strength: z.number().min(0).max(1.5) }),
  z.object({ op: z.literal('sharpen'), amount: z.number().min(0).max(3), radius: z.number().min(0.3).max(5) }),
  z.object({ op: z.literal('clahe'), clipLimit: z.number().min(1).max(8), tiles: z.number().int().min(2).max(16) }),
  z.object({ op: z.literal('dehaze'), strength: z.number().min(0).max(1) }),
  z.object({ op: z.literal('low_light'), strength: z.number().min(0).max(1) }),
  z.object({ op: z.literal('deblur'), psf: z.literal('gaussian'), sigma: z.number().min(0.3).max(6), iterations: z.number().int().min(1).max(60) }),
  z.object({ op: z.literal('deblur'), psf: z.literal('motion'), length: z.number().min(1).max(60), angleDeg: z.number().min(-180).max(180), iterations: z.number().int().min(1).max(60) }),
  z.object({ op: z.literal('white_balance') }),
  z.object({ op: z.literal('levels'), lowPct: z.number().min(0).max(20), highPct: z.number().min(80).max(100) }),
  z.object({ op: z.literal('gamma'), gamma: z.number().min(0.2).max(5) }),
  z.object({ op: z.literal('upscale'), factor: z.number().min(1).max(4) }),
  z.object({ op: z.literal('grayscale') }),
  z.object({ op: z.literal('crop'), x: z.number().min(0), y: z.number().min(0), w: z.number().min(1), h: z.number().min(1) }),
]);

/** Short-lived analysed-photo cache for two-step enrolment and ad-hoc searches (choose a face, then act). */
const photoCache = new Map<string, { at: number; faces: FaceOut[]; sha256: string; by: string }>();
function remember(faces: FaceOut[], sha256: string, by: string): string {
  const now = Date.now();
  for (const [k, v] of photoCache) if (now - v.at > 15 * 60_000) photoCache.delete(k);
  const token = randomUUID();
  photoCache.set(token, { at: now, faces, sha256, by });
  return token;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof EvidenceError || e instanceof IdentityError) return reply.code(400).send({ error: e.message });
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith('MODEL_UNAVAILABLE')) return reply.code(503).send({ error: msg.replace('MODEL_UNAVAILABLE: ', ''), code: 'MODEL_UNAVAILABLE' });
  if (/too large|limited to|between 8×8|not enough frames|unsupported|corrupt|decode/i.test(msg)) return reply.code(422).send({ error: msg });
  throw e;
}

/** Hide watchlist basis/notes from roles that may see a recognition result but not the intelligence behind it. */
function redact(i: Identity, role: Parameters<typeof can>[0]): Identity {
  return i.list === 'WATCHLIST' && !can(role, 'identity.watchlist') ? { ...i, basis: null, notes: null } : i;
}

export function registerVision(app: FastifyInstance, p: Platform): void {
  // Raw upload stream: the body is passed through untouched for streaming storage.
  app.addContentTypeParser('application/x-strata-upload', (_req, payload, done) => done(null, payload));

  app.get('/api/vision/status', { preHandler: requirePerm('evidence.view') }, async () => ({ ...(await p.vision.status()), gallery: p.identity.gallerySize, settings: p.identity.settings }));

  // ---------------------------------------------------------------------------------------------------
  // Evidence library

  const ItemMeta = z.object({
    title: z.string().min(1).max(200),
    originalName: z.string().max(300).nullish(),
    capturedAt: z.coerce.number().int().positive().nullish(),
    capturedAtBasis: z.string().max(200).nullish(),
    lat: z.coerce.number().min(-90).max(90).nullish(),
    lon: z.coerce.number().min(-180).max(180).nullish(),
    incidentId: z.string().max(60).nullish(),
    classification: z.enum(['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET']).default('RESTRICTED'),
    notes: z.string().max(4000).nullish(),
    analyze: z.enum(['0', '1']).default('1'),
    mode: z.enum(['standard', 'thorough']).default('standard'),
  });

  app.post('/api/evidence/items', { preHandler: requirePerm('evidence.upload'), bodyLimit: MAX_UPLOAD_BYTES, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const meta = parse(ItemMeta, req.query, reply);
    if (!meta) return;
    if (req.headers['content-type'] !== 'application/x-strata-upload') return reply.code(415).send({ error: 'send the file as application/x-strata-upload' });
    try {
      const stored = await p.store.putStream('evidence', req.body as Readable, MAX_UPLOAD_BYTES);
      const r = await p.evidence.ingest(
        stored,
        {
          title: meta.title,
          originalName: meta.originalName ?? null,
          mime: null,
          source: 'upload',
          capturedAt: meta.capturedAt ?? null,
          capturedAtBasis: meta.capturedAt ? (meta.capturedAtBasis ?? 'entered by operator') : null,
          lat: meta.lat ?? null,
          lon: meta.lon ?? null,
          incidentId: meta.incidentId ?? null,
          classification: meta.classification,
          notes: meta.notes ?? null,
          analyze: meta.analyze === '1',
          mode: meta.mode,
        },
        { username: req.user!.username, role: req.user!.role, ip: req.ip },
      );
      return reply.code(r.duplicate ? 200 : 201).send(r);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/evidence/items', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const q = parse(z.object({ q: z.string().max(100).optional(), incident: z.string().max(60).optional(), kind: z.enum(['image', 'video']).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query, reply);
    if (!q) return;
    return p.evidence.list({ q: q.q, incidentId: q.incident, kind: q.kind, limit: q.limit });
  });

  app.get('/api/evidence/items/:id', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const it = await p.evidence.get((req.params as { id: string }).id);
    return it ?? reply.code(404).send({ error: 'unknown evidence item' });
  });

  app.patch('/api/evidence/items/:id', { preHandler: requirePerm('evidence.upload') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(ItemMeta.partial().omit({ analyze: true, mode: true }), req.body, reply);
    if (!b) return;
    try {
      const it = await p.evidence.update(id, { ...b, capturedAt: b.capturedAt, capturedAtBasis: b.capturedAtBasis });
      await audit(p, req, 'evidence_metadata_updated', id, b);
      return it;
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/evidence/items/:id/original', { preHandler: requirePerm('evidence.export') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const o = await p.evidence.original(id);
    if (!o) return reply.code(404).send({ error: 'unknown evidence item' });
    await audit(p, req, 'evidence_original_exported', id, { sha256: o.item.sha256 });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${id}-${(o.item.originalName ?? 'original').replace(/[^\w.-]/g, '_')}"`)
      .header('x-sha256', o.item.sha256)
      .send(Buffer.from(o.bytes));
  });

  app.get('/api/evidence/items/:id/frame', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = parse(z.object({ t: z.coerce.number().min(0).optional(), w: z.coerce.number().int().min(64).max(4096).default(1600) }), req.query, reply);
    if (!q) return;
    try {
      const f = await p.evidence.frame(id, q.t ?? 0, 'jpeg', q.w);
      return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=600').header('x-evidence-state', 'ORIGINAL').send(Buffer.from(f.bytes));
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/evidence/items/:id/detections', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const q = parse(z.object({ t: z.coerce.number().min(0).optional() }), req.query, reply);
    if (!q) return;
    return p.evidence.detections((req.params as { id: string }).id, q.t ?? null);
  });

  app.post('/api/evidence/items/:id/analyze', { preHandler: requirePerm('evidence.upload') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(z.object({ mode: z.enum(['standard', 'thorough']).default('standard') }), req.body ?? {}, reply);
    if (!b) return;
    if (!(await p.evidence.get(id))) return reply.code(404).send({ error: 'unknown evidence item' });
    void p.evidence.analyze(id, b.mode);
    await audit(p, req, 'evidence_analysis_requested', id, b);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/evidence/items/:id/enhance', { preHandler: requirePerm('evidence.enhance') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(z.object({ t: z.number().min(0).nullish(), ops: z.array(EnhanceOpSchema).max(12), aiUpscale: z.boolean().default(false), notes: z.string().max(2000).nullish() }), req.body, reply);
    if (!b) return;
    try {
      const prod = await p.evidence.enhance(id, b.t ?? null, b.ops, b.aiUpscale, req.user!.username, b.notes ?? null);
      await audit(p, req, 'evidence_enhanced', `${id}:${prod.id}`, { state: prod.state, ops: b.ops.map((o) => o.op), aiUpscale: b.aiUpscale, sha256Out: prod.sha256Out });
      return prod;
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/evidence/items/:id/multiframe', { preHandler: requirePerm('evidence.enhance') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(z.object({ t: z.number().min(0), roi: z.object({ x: z.number().min(0), y: z.number().min(0), w: z.number().min(8).max(200), h: z.number().min(8).max(200) }), frames: z.number().int().min(3).max(32).default(12), scale: z.number().int().min(2).max(4).default(3), notes: z.string().max(2000).nullish() }), req.body, reply);
    if (!b) return;
    try {
      const prod = await p.evidence.multiFrame(id, b.t, b.roi, b.frames, b.scale, req.user!.username, b.notes ?? null);
      await audit(p, req, 'evidence_multiframe', `${id}:${prod.id}`, { roi: b.roi, frames: b.frames, usedFrames: prod.usedFrames, sha256Out: prod.sha256Out });
      return prod;
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/evidence/items/:id/capture', { preHandler: requirePerm('evidence.enhance') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(z.object({ t: z.number().min(0) }), req.body, reply);
    if (!b) return;
    try {
      const prod = await p.evidence.captureFrame(id, b.t, req.user!.username);
      await audit(p, req, 'evidence_frame_captured', `${id}:${prod.id}`, { t: b.t, sha256Out: prod.sha256Out });
      return prod;
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/evidence/items/:id/products', { preHandler: requirePerm('evidence.view') }, async (req) => p.evidence.products((req.params as { id: string }).id));

  app.get('/api/evidence/products/:id/image', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const q = parse(z.object({ which: z.enum(['preview', 'full']).default('preview'), download: z.enum(['0', '1']).default('0') }), req.query, reply);
    if (!q) return;
    const id = (req.params as { id: string }).id;
    const r = await p.evidence.productBytes(id, q.which);
    if (!r) return reply.code(404).send({ error: 'unknown product' });
    if (q.download === '1') {
      if (!can(req.user!.role, 'evidence.export')) return reply.code(403).send({ error: 'export requires evidence.export' });
      await audit(p, req, 'evidence_product_exported', `${r.product.itemId}:${id}`, { sha256: r.product.sha256Out, state: r.product.state });
      void reply.header('content-disposition', `attachment; filename="${id}-${r.product.state}.png"`);
    }
    return reply.header('content-type', r.mime).header('x-evidence-state', r.product.state).header('x-sha256', r.product.sha256Out).header('cache-control', 'private, max-age=3600').send(Buffer.from(r.bytes));
  });

  app.get('/api/evidence/items/:id/report', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const r = await p.evidence.report(id);
      await audit(p, req, 'evidence_report_viewed', id, {});
      return r;
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ---------------------------------------------------------------------------------------------------
  // Faces in an ad-hoc photo (enrolment, search by photo)

  app.post('/api/vision/faces', { preHandler: requirePerm('identity.view'), bodyLimit: 40 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body;
    if (!(body instanceof Buffer)) return reply.code(415).send({ error: 'send the image as image/jpeg, image/png or application/octet-stream' });
    try {
      const r = await p.vision.interactive.run('analyze_image', { bytes: new Uint8Array(body), objects: false, faces: true, tiled: true, maxFaces: 20 });
      const token = remember(r.faces, r.sha256, req.user!.username);
      return {
        token,
        sha256: r.sha256,
        width: r.width,
        height: r.height,
        faces: r.faces.map((f, index) => ({ index, box: f.box, quality: f.quality, usable: Boolean(f.embedding), crop: b64(f.crop), matches: f.embedding ? p.identity.match(f.embedding, 3) : [] })),
      };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  // ---------------------------------------------------------------------------------------------------
  // Identity registry

  app.get('/api/identities', { preHandler: requirePerm('identity.view') }, async (req, reply) => {
    const q = parse(z.object({ list: z.enum(['AUTHORISED', 'WATCHLIST']).optional(), q: z.string().max(100).optional() }), req.query, reply);
    if (!q) return;
    return (await p.identity.listIdentities(q)).map((i) => redact(i, req.user!.role));
  });

  app.post('/api/identities', { preHandler: requirePerm('identity.enrol') }, async (req, reply) => {
    const b = parse(IdentityInput, req.body, reply);
    if (!b) return;
    if (b.list === 'WATCHLIST' && !can(req.user!.role, 'identity.watchlist')) return reply.code(403).send({ error: 'watchlist entries require identity.watchlist' });
    try {
      const i = await p.identity.createIdentity(b, req.user!.username);
      await audit(p, req, b.list === 'WATCHLIST' ? 'watchlist_entry_created' : 'identity_created', i.id, { name: i.name, category: i.category, basis: b.basis ?? null });
      return reply.code(201).send(i);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/identities/:id', { preHandler: requirePerm('identity.view') }, async (req, reply) => {
    const i = await p.identity.getIdentity((req.params as { id: string }).id);
    if (!i) return reply.code(404).send({ error: 'unknown identity' });
    return { ...redact(i, req.user!.role), templates: await p.identity.templates(i.id) };
  });

  app.patch('/api/identities/:id', { preHandler: requirePerm('identity.enrol') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(IdentityInput.partial().omit({ list: true }).extend({ status: z.enum(['ACTIVE', 'SUSPENDED', 'REMOVED']).optional() }), req.body, reply);
    if (!b) return;
    const cur = await p.identity.getIdentity(id);
    if (!cur) return reply.code(404).send({ error: 'unknown identity' });
    if (cur.list === 'WATCHLIST' && !can(req.user!.role, 'identity.watchlist')) return reply.code(403).send({ error: 'watchlist entries require identity.watchlist' });
    try {
      const i = await p.identity.updateIdentity(id, b);
      await audit(p, req, 'identity_updated', id, b);
      return i;
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/identities/:id/templates', { preHandler: requirePerm('identity.enrol') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(z.union([z.object({ token: z.string().uuid(), faceIndex: z.number().int().min(0) }), z.object({ faceEventId: z.string().max(40) })]), req.body, reply);
    if (!b) return;
    try {
      let face: FaceOut | undefined;
      let source = 'upload';
      let sha: string | null = null;
      if ('token' in b) {
        const c = photoCache.get(b.token);
        if (!c) return reply.code(410).send({ error: 'photo analysis expired; upload the photo again' });
        face = c.faces[b.faceIndex];
        sha = c.sha256;
      } else {
        const ev = await p.identity.getFaceEvent(b.faceEventId);
        const emb = await p.identity.faceEmbedding(b.faceEventId);
        const crop = await p.identity.faceImage(b.faceEventId, 'crop');
        const aligned = await p.identity.faceImage(b.faceEventId, 'aligned');
        if (!ev || !emb || !crop || !aligned) return reply.code(404).send({ error: 'face sighting not found or has no usable embedding' });
        face = { box: ev.box, landmarks: [], score: ev.quality.detectorScore, quality: ev.quality, embedding: emb, crop, aligned };
        source = `face_event:${ev.id}`;
      }
      if (!face) return reply.code(400).send({ error: 'no such face in that photo' });
      const r = await p.identity.addTemplate(id, face, source, sha, req.user!.username);
      await audit(p, req, 'identity_template_enrolled', id, { template: r.id, source, quality: face.quality.grade, duplicateOf: r.duplicateOf });
      return reply.code(201).send(r);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.delete('/api/identities/templates/:tid', { preHandler: requirePerm('identity.enrol') }, async (req) => {
    const tid = (req.params as { tid: string }).tid;
    await p.identity.removeTemplate(tid);
    await audit(p, req, 'identity_template_removed', tid, {});
    return { ok: true };
  });

  app.get('/api/identities/templates/:tid/image', { preHandler: requirePerm('identity.view') }, async (req, reply) => {
    const q = parse(z.object({ which: z.enum(['crop', 'aligned']).default('crop') }), req.query, reply);
    if (!q) return;
    const img = await p.identity.templateImage((req.params as { tid: string }).tid, q.which);
    return img ? reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=3600').send(Buffer.from(img)) : reply.code(404).send({ error: 'not found' });
  });

  // ---------------------------------------------------------------------------------------------------
  // Face sightings, review and search

  app.get('/api/faces', { preHandler: requirePerm('identity.view') }, async (req, reply) => {
    const q = parse(
      z.object({
        review: z.enum(['PENDING', 'CONFIRMED', 'REJECTED', 'NOT_REQUIRED']).optional(),
        identity: z.string().max(40).optional(),
        source: z.string().max(40).optional(),
        decision: z.enum(['STRONG', 'POSSIBLE', 'NO_MATCH', 'NOT_COMPARABLE']).optional(),
        from: z.coerce.number().int().optional(),
        to: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
      reply,
    );
    if (!q) return;
    return p.identity.listFaceEvents({ review: q.review, identityId: q.identity, sourceId: q.source, decision: q.decision, from: q.from, to: q.to, limit: q.limit });
  });

  app.get('/api/faces/settings', { preHandler: requirePerm('identity.view') }, async () => p.identity.settings);

  app.put('/api/faces/settings', { preHandler: requirePerm('admin.config') }, async (req, reply) => {
    const b = parse(FaceSettings, req.body, reply);
    if (!b) return;
    try {
      await p.identity.saveSettings(b, req.user!.username);
      await audit(p, req, 'face_settings_changed', 'face.settings', b);
      return b;
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/faces/:id', { preHandler: requirePerm('identity.view') }, async (req, reply) => {
    const ev = await p.identity.getFaceEvent((req.params as { id: string }).id);
    return ev ?? reply.code(404).send({ error: 'unknown face sighting' });
  });

  app.get('/api/faces/:id/image', { preHandler: requirePerm('identity.view') }, async (req, reply) => {
    const q = parse(z.object({ which: z.enum(['crop', 'aligned']).default('crop') }), req.query, reply);
    if (!q) return;
    const img = await p.identity.faceImage((req.params as { id: string }).id, q.which);
    return img ? reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=3600').send(Buffer.from(img)) : reply.code(404).send({ error: 'not found' });
  });

  app.post('/api/faces/:id/review', { preHandler: requirePerm('face.review') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(z.object({ decision: z.enum(['CONFIRMED', 'REJECTED']), note: z.string().min(3).max(2000), identityId: z.string().max(40).optional() }), req.body, reply);
    if (!b) return;
    try {
      const ev = await p.identity.review(id, b.decision, b.note, req.user!.username, b.identityId);
      await audit(p, req, 'face_reviewed', id, { decision: b.decision, identity: ev.bestIdentityId, note: b.note });
      return ev;
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post('/api/faces/search', { preHandler: requirePerm('face.search') }, async (req, reply) => {
    const b = parse(
      z.object({
        faceEventId: z.string().max(40).optional(),
        identityId: z.string().max(40).optional(),
        token: z.string().uuid().optional(),
        faceIndex: z.number().int().min(0).optional(),
        purpose: z.string().min(5).max(500),
        minScore: z.number().min(0.1).max(0.95).optional(),
        from: z.number().int().optional(),
        to: z.number().int().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      req.body,
      reply,
    );
    if (!b) return;
    let probes: number[][] = [];
    if (b.faceEventId) {
      const e = await p.identity.faceEmbedding(b.faceEventId);
      if (e) probes = [e];
    } else if (b.identityId) {
      const rows = (await p.db.query<{ embedding: number[] }>('SELECT embedding FROM identity_templates WHERE identity_id = $1', [b.identityId])).rows;
      probes = rows.map((r) => r.embedding);
    } else if (b.token !== undefined && b.faceIndex !== undefined) {
      const f = photoCache.get(b.token)?.faces[b.faceIndex];
      if (f?.embedding) probes = [f.embedding];
    }
    if (!probes.length) return reply.code(400).send({ error: 'no usable probe face (give faceEventId, identityId with templates, or token+faceIndex of a usable face)' });
    const minScore = b.minScore ?? p.identity.settings.possible;
    const merged = new Map<string, Awaited<ReturnType<typeof p.identity.search>>[number]>();
    for (const probe of probes)
      for (const r of await p.identity.search(probe, { minScore, from: b.from, to: b.to, limit: b.limit })) {
        const cur = merged.get(r.id);
        if (!cur || r.score > cur.score) merged.set(r.id, r);
      }
    const results = [...merged.values()].sort((x, y) => y.score - x.score).slice(0, b.limit);
    await audit(p, req, 'face_search', b.faceEventId ?? b.identityId ?? 'photo', { purpose: b.purpose, minScore, results: results.length });
    return { minScore, strong: p.identity.settings.strong, results };
  });
}
