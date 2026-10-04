import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { buildCot, can, cotToExternal, cotTypeForTrack, CotStreamSplitter, FACILITY, findSensor, INGEST_SCHEMA_VERSION, parseCot, type TrackSnapshot } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { isService, parse } from '../http/guards.ts';

/**
 * C2 interop over Cursor-on-Target.
 *  GET  /api/interop/cot   — the current track picture as CoT events (service token or a signed-in viewer).
 *  POST /api/interop/cot   — CoT XML pushed by another system (service token), as reports of an external feed.
 */
export function registerInterop(app: FastifyInstance, p: Platform): void {
  app.addContentTypeParser(['application/xml', 'text/xml', 'application/cot+xml'], { parseAs: 'string', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  const allowed = (req: FastifyRequest) => isService(req, p.cfg.STRATA_SERVICE_TOKEN) || (req.user && can(req.user.role, 'world.view'));

  app.get('/api/interop/cot', async (req, reply) => {
    if (!allowed(req)) return reply.code(401).send({ error: 'service token or world.view required' });
    const q = parse(z.object({ categories: z.string().optional(), format: z.enum(['json', 'xml']).default('json'), staleS: z.coerce.number().int().min(5).max(3600).default(30) }), req.query, reply);
    if (!q) return;
    const cats = q.categories ? new Set(q.categories.split(',')) : null;
    const t = p.liveEdge();
    const externals = new Set(FACILITY.sensors.filter((s) => s.kind === 'external').map((s) => s.id));
    const events = p.fusion.engine
      .snapshots(t)
      .filter((s) => (s.status === 'confirmed' || s.status === 'coasting') && (!cats || cats.has(s.category)))
      // A track known only from another system's reports is not re-published (avoids echo loops between systems).
      .filter((s) => s.contributors.some((c) => !externals.has(c)))
      .map((s) => trackEvent(p, s, t, q.staleS));
    if (q.format === 'xml') return reply.type('application/xml').send(`<events>${events.map((e) => e.replace(/^<\?xml[^>]*\?>/, '')).join('')}</events>`);
    return { t, facility: FACILITY.id, events };
  });

  app.post('/api/interop/cot', { config: { rateLimit: false } }, async (req, reply) => {
    if (!isService(req, p.cfg.STRATA_SERVICE_TOKEN)) return reply.code(401).send({ error: 'service token required' });
    const q = parse(z.object({ sensorId: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/), system: z.string().max(32).optional() }), req.query, reply);
    if (!q) return;
    const def = findSensor(q.sensorId);
    if (!def || def.kind !== 'external') return reply.code(400).send({ error: `${q.sensorId} is not a registered external feed (Site setup → Data feeds)` });
    if (typeof req.body !== 'string') return reply.code(415).send({ error: 'send CoT XML with content-type application/xml' });
    const docs = new CotStreamSplitter().push(req.body);
    const messages: unknown[] = [];
    const errors: string[] = [];
    let ignored = 0;
    const now = Date.now();
    for (const xml of docs) {
      const r = parseCot(xml);
      if (!r.ok) {
        errors.push(r.reason);
        continue;
      }
      if (r.event.uid.startsWith('strata.')) {
        ignored++;
        continue;
      }
      const ext = cotToExternal(r.event, q.system ?? def.system);
      if (!ext) {
        ignored++;
        continue;
      }
      messages.push({ schema: INGEST_SCHEMA_VERSION, messageId: `cot:${q.sensorId}:${r.event.uid.slice(0, 48)}:${r.event.time}`, sensorId: q.sensorId, adapter: 'strata.cot-http.v1', seq: 0, observedAt: Math.min(r.event.time, now), sentAt: now, kind: 'external.track', payload: ext });
    }
    const res = messages.length ? await p.ingest.process(messages) : { accepted: 0, duplicates: 0, rejected: [] };
    return reply.code(errors.length || res.rejected.length ? 207 : 202).send({ events: docs.length, accepted: res.accepted, duplicates: res.duplicates, ignored, rejected: [...errors.map((reason) => ({ reason })), ...res.rejected] });
  });
}

function trackEvent(p: Platform, s: TrackSnapshot, t: number, staleS: number): string {
  const g = p.ingest.frame.toGeodetic(s.position);
  const speed = Math.hypot(s.velocity.x, s.velocity.y);
  const course = (Math.atan2(s.velocity.x, s.velocity.y) * (180 / Math.PI) + 360) % 360;
  const facts = [`${s.classification}`, `${s.status}`, `conf ${s.confidence.toFixed(2)}`, `sources ${s.contributors.join(',')}`];
  if (s.reported && s.reported.affiliation !== 'friend') facts.push(`reported ${s.reported.affiliation} by ${s.reported.system}`);
  return buildCot({
    uid: `strata.${FACILITY.id}.${s.id}`,
    type: cotTypeForTrack(s),
    callsign: s.label,
    lat: g.lat,
    lon: g.lon,
    hae: g.alt,
    ce: Math.max(1, s.sigmaH),
    le: Math.max(1, s.sigmaV),
    time: t,
    staleS,
    ...(speed > 0.3 ? { courseDeg: course, speedMps: speed } : {}),
    remarks: `Strata ${FACILITY.name}: ${facts.join('; ')}. Fused track (decision support).`,
    how: s.cooperative ? 'm-g' : 'm-f',
  });
}
