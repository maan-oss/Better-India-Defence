import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import jpeg from 'jpeg-js';
import { FACILITY, findSensor, type EvidenceRef } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { audit, parse, requirePerm } from '../http/guards.ts';
import { MediaUnavailable } from '../media/mediaService.ts';

const time = z.coerce.number().int().min(0);
const lastTimelineAudit = new Map<string, number>();

/** World, replay, evidence, alerts, incidents, media, reconstruction, hand-off, copilot and simulation routes. */
export function registerOperations(app: FastifyInstance, p: Platform): void {
  // ------------------------------------------------------------------ replay / time engine
  app.get('/api/replay/range', { preHandler: requirePerm('timeline.view') }, async () => ({ ...(await p.replay.range()), liveEdge: p.liveEdge() }));

  app.get('/api/replay/tracks', { preHandler: requirePerm('timeline.view') }, async (req, reply) => {
    const q = parse(z.object({ from: time, to: time }), req.query, reply);
    if (!q) return;
    if (q.to - q.from > 31 * 60_000 || q.to < q.from) return reply.code(400).send({ error: 'window must be ≤ 31 minutes' });
    const key = req.user!.username;
    // Timeline access is audited (rate-limited to one record per user per 10 minutes).
    if (q.to < p.liveEdge() - 120_000 && Date.now() - (lastTimelineAudit.get(key) ?? 0) > 600_000) {
      lastTimelineAudit.set(key, Date.now());
      void audit(p, req, 'timeline_access', null, { from: q.from, to: q.to });
    }
    return p.replay.trackWindow(q.from, q.to);
  });

  app.get('/api/replay/timeline', { preHandler: requirePerm('timeline.view') }, async (req, reply) => {
    const q = parse(z.object({ from: time, to: time, buckets: z.coerce.number().int().min(10).max(2000).default(400) }), req.query, reply);
    if (!q) return;
    return p.replay.timeline(q.from, q.to, q.buckets);
  });

  app.get('/api/replay/state', { preHandler: requirePerm('timeline.view') }, async (req, reply) => {
    const q = parse(z.object({ t: time }), req.query, reply);
    if (!q) return;
    const [sensors, infrastructure] = await Promise.all([p.replay.sensorStatusAt(q.t), p.replay.infrastructureAt(q.t)]);
    return { t: q.t, sensors, infrastructure, objects: p.replay.objectsAt(q.t), structures: p.replay.structuresAt(q.t) };
  });

  app.get('/api/replay/diff', { preHandler: requirePerm('timeline.view') }, async (req, reply) => {
    const q = parse(z.object({ a: time, b: time }), req.query, reply);
    if (!q) return;
    return p.replay.diff(q.a, q.b);
  });

  app.get('/api/live/tracks', { preHandler: requirePerm('world.view') }, async () => {
    const t = p.liveEdge();
    return { t, tracks: p.fusion.engine.snapshots(t) };
  });

  // ------------------------------------------------------------------ coverage / evidence
  app.get('/api/coverage', { preHandler: requirePerm('world.view') }, async (req, reply) => {
    const q = parse(z.object({ t: time }), req.query, reply);
    if (!q) return;
    if (!p.coverage.ready) return reply.code(503).send({ error: 'coverage model still initialising' });
    return p.coverage.supportAt(q.t);
  });

  app.get('/api/evidence/patch/:id', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ t: time }), req.query, reply);
    if (!q) return;
    const d = await p.coverage.patchDetail(id, q.t);
    if (!d) return reply.code(404).send({ error: 'unknown surface' });
    void audit(p, req, 'evidence_viewed', id, { kind: 'surface', t: q.t });
    return d;
  });

  app.get('/api/evidence/observation/:id', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const o = await p.replay.observation(id);
    if (!o) return reply.code(404).send({ error: 'unknown observation' });
    void audit(p, req, 'evidence_viewed', id, { kind: 'observation' });
    return o;
  });

  app.get('/api/tracks/:id', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ t: time.optional() }), req.query, reply);
    if (!q) return;
    const t = q.t ?? p.liveEdge();
    const tr = (await p.db.query<Record<string, unknown>>('SELECT * FROM tracks WHERE id = $1', [id])).rows[0];
    if (!tr) return reply.code(404).send({ error: 'unknown track' });
    const history = (await p.db.query<{ t: number; x: number; y: number; z: number; status: string; sigma_h: number; confidence: number; contributors: string[]; observation_ids: string[] }>(
      'SELECT t, x, y, z, status, sigma_h, confidence, contributors, observation_ids FROM track_states WHERE track_id = $1 AND t <= $2 ORDER BY t DESC LIMIT 400',
      [id, t],
    )).rows.reverse();
    const recentObsIds = history.slice(-12).flatMap((h) => h.observation_ids).slice(-30);
    const observations = recentObsIds.length
      ? (await p.db.query<{ id: string; sensor_id: string; t: number; kind: string; source_kind: string; state: string; x: number | null; y: number | null; quality: Record<string, unknown>; payload: Record<string, unknown> }>(
          'SELECT id, sensor_id, t, kind, source_kind, state, x, y, quality, payload FROM observations WHERE id = ANY($1) ORDER BY t DESC',
          [recentObsIds],
        )).rows
      : [];
    const live = p.fusion.engine.snapshot(id, t);
    const lastConfirmed = [...history].reverse().find((h) => h.status === 'confirmed' || h.status === 'tentative') ?? null;
    void audit(p, req, 'evidence_viewed', id, { kind: 'track', t });
    return { track: tr, snapshot: live, history, observations, lastConfirmed };
  });

  app.get('/api/sensors', { preHandler: requirePerm('world.view') }, async () => {
    const rates = (await p.db.query<{ sensor_id: string; n: number }>(`SELECT sensor_id, count(*)::int AS n FROM observations WHERE t > $1 GROUP BY sensor_id`, [p.liveEdge() - 600_000])).rows;
    return FACILITY.sensors.map((s) => ({ definition: s, status: p.sensors.get(s.id) ?? null, observationsLast10Min: rates.find((r) => r.sensor_id === s.id)?.n ?? 0, cameraCoverage: s.kind === 'camera' ? (p.coverage.visibility[s.id]?.length ?? 0) : null }));
  });

  app.get('/api/sensors/:id', { preHandler: requirePerm('world.view') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const def = findSensor(id);
    if (!def) return reply.code(404).send({ error: 'unknown sensor' });
    const events = (await p.db.query('SELECT t, status, previous, message FROM sensor_status_events WHERE sensor_id = $1 ORDER BY t DESC LIMIT 100', [id])).rows;
    const recent = (await p.db.query('SELECT id, t, kind, source_kind, state, quality FROM observations WHERE sensor_id = $1 ORDER BY t DESC LIMIT 50', [id])).rows;
    const hist = (await p.db.query<{ b: number; n: number }>(`SELECT floor((t - $2::bigint) / 60000)::int AS b, count(*)::int AS n FROM observations WHERE sensor_id = $1 AND t > $2::bigint GROUP BY b ORDER BY b`, [id, p.liveEdge() - 3600_000])).rows;
    return { definition: def, status: p.sensors.get(id) ?? null, events, recent, perMinute: hist, coveragePatches: def.kind === 'camera' ? (p.coverage.visibility[id]?.length ?? 0) : null };
  });

  app.get('/api/world/changes', { preHandler: requirePerm('world.view') }, async (req, reply) => {
    const q = parse(z.object({ from: time, to: time }), req.query, reply);
    if (!q) return;
    return (await p.db.query('SELECT * FROM world_changes WHERE t BETWEEN $1 AND $2 ORDER BY t DESC LIMIT 500', [q.from, q.to])).rows;
  });

  app.get('/api/world/changes/:id', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = (await p.db.query('SELECT * FROM world_changes WHERE id = $1', [id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'unknown change' });
    void audit(p, req, 'evidence_viewed', id, { kind: 'change' });
    return c;
  });

  app.get('/api/evidence/search', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const q = parse(
      z.object({ sensorId: z.string().max(24).optional(), kind: z.enum(['track', 'media', 'spatial', 'rf', 'position', 'health', 'infrastructure', 'imagery']).optional(), state: z.enum(['CAPTURED', 'RECONSTRUCTED', 'INFERRED']).optional(), from: time.optional(), to: time.optional(), flagged: z.enum(['0', '1']).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
      req.query,
      reply,
    );
    if (!q) return;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.sensorId) add('sensor_id = ?', q.sensorId.toUpperCase());
    if (q.kind) add('kind = ?', q.kind);
    if (q.state) add('state = ?', q.state);
    if (q.from !== undefined) add('t >= ?::bigint', q.from);
    if (q.to !== undefined) add('t <= ?::bigint', q.to);
    if (q.flagged === '1') where.push(`quality <> '{}'::jsonb`);
    params.push(q.limit);
    const rows = (await p.db.query(`SELECT id, sensor_id, kind, source_kind, t, received_at, state, quality, x, y, adapter FROM observations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t DESC LIMIT $${params.length}`, params)).rows;
    return rows;
  });

  app.get('/api/media', { preHandler: requirePerm('media.view') }, async (req, reply) => {
    const q = parse(z.object({ kind: z.enum(['pointcloud', 'imagery', 'frame', 'reconstruction']).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query, reply);
    if (!q) return;
    return (await p.db.query(`SELECT id, sensor_id, kind, captured_at, content_type, bytes, sha256, encrypted, meta, created_at FROM media_assets ${q.kind ? 'WHERE kind = $2' : ''} ORDER BY captured_at DESC LIMIT $1`, q.kind ? [q.limit, q.kind] : [q.limit])).rows;
  });

  app.get('/api/imagery', { preHandler: requirePerm('evidence.view') }, async () => (await p.db.query('SELECT * FROM imagery_captures ORDER BY acquired_at DESC LIMIT 200')).rows);

  app.get('/api/search', { preHandler: requirePerm('world.view') }, async (req, reply) => {
    const q = parse(z.object({ q: z.string().min(1).max(64) }), req.query, reply);
    if (!q) return;
    const s = q.q.toLowerCase();
    const results: { kind: string; id: string; label: string; detail: string }[] = [];
    for (const b of FACILITY.buildings) if (b.name.toLowerCase().includes(s) || `building ${b.label}`.toLowerCase() === s || b.label.toLowerCase() === s) results.push({ kind: 'building', id: b.id, label: `${b.label} — ${b.name}`, detail: 'structure' });
    for (const z2 of FACILITY.zones) if (z2.name.toLowerCase().includes(s)) results.push({ kind: 'zone', id: z2.id, label: z2.name, detail: z2.kind });
    for (const se of FACILITY.sensors) if (se.id.toLowerCase().includes(s) || se.name.toLowerCase().includes(s)) results.push({ kind: 'sensor', id: se.id, label: `${se.id} — ${se.name}`, detail: se.kind });
    const tracks = (await p.db.query<{ id: string; label: string; category: string }>('SELECT id, label, category FROM tracks WHERE (lower(id) LIKE $1 OR lower(label) LIKE $1) AND merged_into IS NULL ORDER BY last_t DESC LIMIT 10', [`%${s}%`])).rows;
    for (const t of tracks) results.push({ kind: 'track', id: t.id, label: `${t.id} — ${t.label}`, detail: t.category });
    const incs = (await p.db.query<{ id: string; code: string; title: string }>('SELECT id, code, title FROM incidents WHERE lower(code) LIKE $1 OR lower(title) LIKE $1 LIMIT 5', [`%${s}%`])).rows;
    for (const i of incs) results.push({ kind: 'incident', id: i.id, label: `${i.code} — ${i.title}`, detail: 'incident' });
    const m = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(q.q.trim());
    if (m) results.unshift({ kind: 'coordinates', id: `${m[1]},${m[2]}`, label: `Go to ${m[1]}, ${m[2]}`, detail: Math.abs(Number(m[1])) <= 90 && Math.abs(Number(m[2])) <= 180 && q.q.includes('.') ? 'lat, lon (WGS84) or E, N (m)' : 'E, N (m)' });
    return results.slice(0, 30);
  });

  // ------------------------------------------------------------------ alerts
  app.get('/api/alerts', { preHandler: requirePerm('alerts.view') }, async (req, reply) => {
    const q = parse(z.object({ status: z.string().max(64).optional(), from: time.optional(), to: time.optional(), limit: z.coerce.number().int().min(1).max(2000).optional() }), req.query, reply);
    if (!q) return;
    return p.alerts.list(q);
  });
  const alertAction = (action: 'ack' | 'resolve' | 'dismiss') =>
    app.post(`/api/alerts/:id/${action}`, { preHandler: requirePerm('alerts.acknowledge') }, async (req, reply) => {
      const a = await p.alerts.byId((req.params as { id: string }).id);
      if (!a) return reply.code(404).send({ error: 'unknown alert' });
      if (action === 'ack') {
        a.status = 'acknowledged';
        a.ackBy = req.user!.username;
        a.ackAt = Date.now();
      } else a.status = action === 'resolve' ? 'resolved' : 'dismissed';
      a.notes = [...a.notes, { at: Date.now(), by: req.user!.username, text: action === 'ack' ? 'Acknowledged' : action === 'resolve' ? 'Resolved' : 'Dismissed' }];
      await p.alerts.save(a);
      await audit(p, req, action === 'ack' ? 'alert_acknowledged' : `alert_${action === 'resolve' ? 'resolved' : 'dismissed'}`, a.id, { rule: a.rule });
      return a;
    });
  alertAction('ack');
  alertAction('resolve');
  alertAction('dismiss');
  app.post('/api/alerts/:id/assign', { preHandler: requirePerm('alerts.assign') }, async (req, reply) => {
    const b = parse(z.object({ assignee: z.string().min(1).max(64) }), req.body, reply);
    if (!b) return;
    const a = await p.alerts.byId((req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: 'unknown alert' });
    a.assignedTo = b.assignee;
    a.notes = [...a.notes, { at: Date.now(), by: req.user!.username, text: `Assigned to ${b.assignee}` }];
    await p.alerts.save(a);
    await audit(p, req, 'alert_assigned', a.id, { assignee: b.assignee });
    return a;
  });
  app.post('/api/alerts/:id/notes', { preHandler: requirePerm('alerts.acknowledge') }, async (req, reply) => {
    const b = parse(z.object({ text: z.string().min(1).max(1000) }), req.body, reply);
    if (!b) return;
    const a = await p.alerts.byId((req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: 'unknown alert' });
    a.notes = [...a.notes, { at: Date.now(), by: req.user!.username, text: b.text }];
    await p.alerts.save(a);
    await audit(p, req, 'alert_note', a.id, {});
    return a;
  });

  // ------------------------------------------------------------------ incidents
  app.get('/api/incidents', { preHandler: requirePerm('incidents.view') }, async () => p.incidents.list());
  app.get('/api/incidents/:id', { preHandler: requirePerm('incidents.view') }, async (req, reply) => {
    const inc = await p.incidents.get((req.params as { id: string }).id);
    if (!inc) return reply.code(404).send({ error: 'unknown incident' });
    await audit(p, req, 'incident_opened', inc.code, {});
    return p.incidents.gather(inc);
  });
  app.post('/api/incidents', { preHandler: requirePerm('incidents.create') }, async (req, reply) => {
    const b = parse(
      z.object({ title: z.string().min(3).max(160), t: time, x: z.number().min(-5000).max(5000), y: z.number().min(-5000).max(5000), radiusM: z.number().min(20).max(3000).default(300), beforeMin: z.number().min(0).max(120).default(5), afterMin: z.number().min(0).max(240).default(15), alertId: z.string().optional() }),
      req.body,
      reply,
    );
    if (!b) return;
    const inc = await p.incidents.create({ title: b.title, tStart: b.t - b.beforeMin * 60_000, tEnd: b.t + b.afterMin * 60_000, center: { x: b.x, y: b.y, z: 0 }, radiusM: b.radiusM, createdBy: req.user!.username, ...(b.alertId ? { alertIds: [b.alertId] } : {}), summary: 'Created manually.' });
    await audit(p, req, 'incident_created', inc.code, { t: b.t });
    return reply.code(201).send(inc);
  });
  app.patch('/api/incidents/:id', { preHandler: requirePerm('incidents.edit') }, async (req, reply) => {
    const b = parse(z.object({ status: z.enum(['open', 'investigating', 'closed']).optional(), summary: z.string().max(4000).optional(), title: z.string().min(3).max(160).optional() }), req.body, reply);
    if (!b) return;
    const inc = await p.incidents.update((req.params as { id: string }).id, b);
    if (!inc) return reply.code(404).send({ error: 'unknown incident' });
    await audit(p, req, 'incident_updated', inc.code, b);
    return inc;
  });
  app.post('/api/incidents/:id/evidence', { preHandler: requirePerm('incidents.edit') }, async (req, reply) => {
    const b = parse(z.object({ kind: z.enum(['observation', 'media', 'track', 'reconstruction', 'change', 'alert', 'snapshot']), id: z.string().min(1).max(200), t: time.optional(), sensorId: z.string().max(24).optional(), note: z.string().max(400).optional(), preserveFrame: z.boolean().optional() }), req.body, reply);
    if (!b) return;
    const inc = await p.incidents.get((req.params as { id: string }).id);
    if (!inc) return reply.code(404).send({ error: 'unknown incident' });
    let ref: EvidenceRef = { kind: b.kind, id: b.id, state: 'CAPTURED', ...(b.t !== undefined ? { t: b.t } : {}), ...(b.sensorId ? { sensorId: b.sensorId } : {}), ...(b.note ? { note: b.note } : {}) };
    if (b.preserveFrame && b.sensorId && b.t !== undefined) {
      try {
        const mediaId = await p.media.preserveFrame(b.sensorId, b.t, req.user!.username);
        ref = { kind: 'media', id: mediaId, sensorId: b.sensorId, t: b.t, state: 'CAPTURED', note: b.note ?? 'preserved VMS frame' };
      } catch (e) {
        return reply.code(e instanceof MediaUnavailable ? e.status : 500).send({ error: e instanceof Error ? e.message : 'failed' });
      }
    }
    await p.incidents.addEvidence(inc.id, ref);
    await audit(p, req, 'incident_evidence_added', inc.code, { ...ref });
    return ref;
  });
  app.post('/api/incidents/:id/export', { preHandler: requirePerm('evidence.export') }, async (req, reply) => {
    const inc = await p.incidents.get((req.params as { id: string }).id);
    if (!inc) return reply.code(404).send({ error: 'unknown incident' });
    const pkg = await p.incidents.gather(inc);
    await audit(p, req, 'export_initiated', inc.code, { format: 'json' });
    const { createHash } = await import('node:crypto');
    const body = JSON.stringify({ exportedAt: Date.now(), exportedBy: req.user!.username, classification: 'SYNTHETIC TEST DATA', package: pkg }, null, 2);
    return reply
      .header('content-type', 'application/json')
      .header('content-disposition', `attachment; filename="${inc.code}.json"`)
      .header('x-content-sha256', createHash('sha256').update(body).digest('hex'))
      .send(body);
  });

  // ------------------------------------------------------------------ media
  app.get('/api/media/frame', { preHandler: requirePerm('media.view') }, async (req, reply) => {
    const q = parse(z.object({ sensorId: z.string().regex(/^[A-Z0-9-]{2,24}$/), t: time, crop: z.string().regex(/^\d+(\.\d+)?,\d+(\.\d+)?,\d+(\.\d+)?,\d+(\.\d+)?$/).optional(), scale: z.coerce.number().int().min(1).max(8).default(4), audit: z.enum(['0', '1']).default('0') }), req.query, reply);
    if (!q) return;
    try {
      let bytes = await p.media.frame(q.sensorId, q.t);
      if (q.crop) {
        const [x, y, w, h] = q.crop.split(',').map(Number) as [number, number, number, number];
        const img = jpeg.decode(Buffer.from(bytes), { useTArray: true });
        const pad = Math.max(4, Math.round(h * 0.2));
        const x0 = Math.max(0, Math.floor(x - pad));
        const y0 = Math.max(0, Math.floor(y - pad));
        const x1 = Math.min(img.width, Math.ceil(x + w + pad));
        const y1 = Math.min(img.height, Math.ceil(y + h + pad));
        const cw = x1 - x0;
        const ch = y1 - y0;
        const s = q.scale;
        const out = new Uint8Array(cw * s * ch * s * 4);
        for (let yy = 0; yy < ch * s; yy++)
          for (let xx = 0; xx < cw * s; xx++) {
            const si = ((y0 + Math.floor(yy / s)) * img.width + (x0 + Math.floor(xx / s))) * 4;
            const di = (yy * cw * s + xx) * 4;
            out[di] = img.data[si]!;
            out[di + 1] = img.data[si + 1]!;
            out[di + 2] = img.data[si + 2]!;
            out[di + 3] = 255;
          }
        const enc = jpeg.encode({ data: out, width: cw * s, height: ch * s }, 90);
        bytes = new Uint8Array(enc.data);
      }
      if (q.audit === '1') void audit(p, req, 'evidence_viewed', `${q.sensorId}@${q.t}`, { kind: 'frame' });
      return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=3600').header('x-evidence-state', 'CAPTURED').send(Buffer.from(bytes));
    } catch (e) {
      return reply.code(e instanceof MediaUnavailable ? e.status : 500).send({ error: e instanceof Error ? e.message : 'media error' });
    }
  });

  /** Detections reported with the recorded frame nearest (at or before) t, for overlaying on the frame. */
  app.get('/api/media/detections', { preHandler: requirePerm('media.view') }, async (req, reply) => {
    const q = parse(z.object({ sensorId: z.string().regex(/^[A-Z0-9-]{2,24}$/), t: time }), req.query, reply);
    if (!q) return;
    const frame = (await p.db.query<{ id: string; message_id: string; t: number; payload: Record<string, unknown> }>(
      `SELECT id, message_id, t, payload FROM observations WHERE sensor_id = $1 AND kind = 'media' AND t <= $2 AND t > $2 - 4000 ORDER BY t DESC LIMIT 1`,
      [q.sensorId, q.t],
    )).rows[0];
    if (!frame) return { frame: null, detections: [] };
    const dets = (await p.db.query<{ id: string; state: string; payload: { cls: string; bbox: number[]; score: number; localTrackId: string; isStatic?: boolean } }>(
      `SELECT id, state, payload FROM observations WHERE message_id = $1 AND kind = 'track'`,
      [frame.message_id],
    )).rows;
    return { frame: { observationId: frame.id, t: frame.t, frameId: frame.payload.frameId }, detections: dets.map((d) => ({ observationId: d.id, state: d.state, cls: d.payload.cls, bbox: d.payload.bbox, score: d.payload.score, localTrackId: d.payload.localTrackId, isStatic: d.payload.isStatic ?? false })) };
  });

  app.get('/api/replay/observations', { preHandler: requirePerm('timeline.view') }, async (req, reply) => {
    const q = parse(z.object({ kind: z.enum(['rf']), from: time, to: time }), req.query, reply);
    if (!q) return;
    if (q.to - q.from > 600_000) return reply.code(400).send({ error: 'window ≤ 10 minutes' });
    return (await p.db.query<{ id: string; sensor_id: string; t: number; x: number; y: number; r: number }>(
      `SELECT id, sensor_id, t, x, y, sx * 2 AS r FROM observations WHERE kind = $1 AND t BETWEEN $2 AND $3 ORDER BY t LIMIT 2000`,
      [q.kind, q.from, q.to],
    )).rows;
  });

  app.get('/api/media/:id', { preHandler: requirePerm('media.view') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const m = await p.media.meta(id);
    if (!m) return reply.code(404).send({ error: 'unknown media' });
    const bytes = await p.media.read(id);
    return reply.header('content-type', m.contentType).header('x-sha256', m.sha256).header('cache-control', 'private, max-age=86400').send(Buffer.from(bytes));
  });
  app.get('/api/media/:id/meta', { preHandler: requirePerm('media.view') }, async (req, reply) => {
    const m = await p.media.meta((req.params as { id: string }).id);
    return m ?? reply.code(404).send({ error: 'unknown media' });
  });

  // ------------------------------------------------------------------ reconstructions
  app.get('/api/reconstructions', { preHandler: requirePerm('evidence.view') }, async () => p.recon.list());
  app.get('/api/reconstructions/:id', { preHandler: requirePerm('evidence.view') }, async (req, reply) => {
    const r = await p.recon.get((req.params as { id: string }).id);
    return r ?? reply.code(404).send({ error: 'unknown reconstruction' });
  });
  app.post('/api/reconstructions', { preHandler: requirePerm('reconstruction.run') }, async (req, reply) => {
    const b = parse(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('multi_frame'), cameraId: z.string().regex(/^C\d{2}$/), markingId: z.string().max(64), t: time, frames: z.number().int().min(4).max(32).default(16) }),
        z.object({ kind: z.literal('lidar_dsm'), buildingId: z.string().max(32), t: time }),
      ]),
      req.body,
      reply,
    );
    if (!b) return;
    try {
      const id = b.kind === 'multi_frame' ? await p.recon.requestMultiFrame({ cameraId: b.cameraId, markingId: b.markingId, t: b.t, frames: b.frames }, req.user!.username) : await p.recon.requestDsm(b.buildingId, b.t, req.user!.username);
      await audit(p, req, 'reconstruction_requested', id, b);
      return reply.code(202).send({ id });
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'failed' });
    }
  });

  // ------------------------------------------------------------------ identity hand-off (synthetic subjects only)
  app.get('/api/handoff/subjects', { preHandler: requirePerm('handoff.search') }, async () => p.handoff.subjects());
  app.post('/api/handoff/subjects', async (req, reply) => {
    const { isService } = await import('../http/guards.ts');
    const svc = isService(req, p.cfg.STRATA_SERVICE_TOKEN);
    if (!svc && (!req.user || req.user.role !== 'administrator')) return reply.code(403).send({ error: 'administrator or test-harness service token required' });
    const b = parse(z.object({ id: z.string().regex(/^[a-z0-9-]{3,48}$/), label: z.string().min(1).max(64), consentRef: z.string().min(3).max(128), synthetic: z.boolean(), descriptor: z.array(z.number().finite()).length(16), notes: z.string().max(500).default('') }), req.body, reply);
    if (!b) return;
    await p.handoff.enroll(b, svc ? 'test-harness' : req.user!.username);
    await p.audit.append({ actor: svc ? 'test-harness' : req.user!.username, role: svc ? 'service' : req.user!.role, action: 'test_subject_enrolled', target: b.id, detail: { synthetic: b.synthetic, consentRef: b.consentRef }, ip: req.ip });
    return reply.code(201).send({ ok: true });
  });
  app.post('/api/handoff/search', { preHandler: requirePerm('handoff.search') }, async (req, reply) => {
    const b = parse(z.object({ subjectId: z.string().max(48), from: time, to: time, purpose: z.string().min(4).max(240) }), req.body, reply);
    if (!b) return;
    if (b.to - b.from > 3 * 3600_000) return reply.code(400).send({ error: 'search window limited to 3 hours' });
    await audit(p, req, 'identity_search_demo_accessed', b.subjectId, { from: b.from, to: b.to, purpose: b.purpose });
    const r = await p.handoff.search(b.subjectId, b.from, b.to);
    return r ?? reply.code(404).send({ error: 'unknown or unenrolled test subject' });
  });

  // ------------------------------------------------------------------ copilot
  app.post('/api/copilot/query', { preHandler: requirePerm('copilot.query'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(
      z.object({
        text: z.string().min(1).max(500),
        t: time.optional(),
        context: z.object({ selectedTrackId: z.string().max(16).nullable().optional(), incidentId: z.string().max(32).nullable().optional(), selectedSubject: z.object({ kind: z.enum(['building', 'sensor', 'track', 'zone', 'incident', 'patch', 'change']), id: z.string().max(96), label: z.string().max(160) }).nullable().optional() }).default({}),
      }),
      req.body,
      reply,
    );
    if (!b) return;
    const ans = await p.copilot.ask({ text: b.text, t: b.t ?? p.liveEdge(), context: b.context });
    void audit(p, req, 'copilot_query', null, { text: b.text, intent: ans.intent, provider: ans.provider });
    return ans;
  });
  app.get('/api/copilot/status', { preHandler: requirePerm('copilot.query') }, async () => p.copilot.providerStatus);

  // ------------------------------------------------------------------ simulation lab (proxy to simulator control API)
  const simFetch = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${p.cfg.SIM_URL}${path}`, { ...init, headers: { authorization: `Bearer ${p.cfg.STRATA_SERVICE_TOKEN}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  app.get('/api/sim/state', { preHandler: requirePerm('simulation.control') }, async (_req, reply) => {
    try {
      const r = await simFetch('/control/state');
      return reply.code(r.status).send(r.body);
    } catch {
      return reply.code(503).send({ error: 'simulator not reachable' });
    }
  });
  app.post('/api/sim/scenarios', { preHandler: requirePerm('simulation.control') }, async (req, reply) => {
    try {
      const r = await simFetch('/control/scenarios', { method: 'POST', body: JSON.stringify(req.body) });
      await audit(p, req, 'simulation_scenario_triggered', String((req.body as { key?: string })?.key), {});
      return reply.code(r.status).send(r.body);
    } catch {
      return reply.code(503).send({ error: 'simulator not reachable' });
    }
  });
  app.post('/api/sim/failures', { preHandler: requirePerm('simulation.failure_injection') }, async (req, reply) => {
    try {
      const r = await simFetch('/control/failures', { method: 'POST', body: JSON.stringify(req.body) });
      await audit(p, req, 'failure_injection_changed', null, req.body as Record<string, unknown>);
      return reply.code(r.status).send(r.body);
    } catch {
      return reply.code(503).send({ error: 'simulator not reachable' });
    }
  });
  app.post('/api/sim/burst', { preHandler: requirePerm('simulation.failure_injection') }, async (req, reply) => {
    try {
      const r = await simFetch('/control/burst', { method: 'POST', body: JSON.stringify(req.body) });
      await audit(p, req, 'failure_injection_burst', null, req.body as Record<string, unknown>);
      return reply.code(r.status).send(r.body);
    } catch {
      return reply.code(503).send({ error: 'simulator not reachable' });
    }
  });
}
