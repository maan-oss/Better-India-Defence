import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { READINESS_LEVELS, TASK_STATUSES, DEFAULT_SOPS, READINESS_INFO, fromMgrs, FACILITY, INGEST_SCHEMA_VERSION } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { audit, parse, requirePerm } from '../http/guards.ts';
import { OpsError, TeamInput, VaInput } from '../ops/opsService.ts';

function err(reply: FastifyReply, e: unknown) {
  if (e instanceof OpsError) return reply.code(400).send({ error: e.message });
  throw e;
}

const point = z.object({ x: z.number(), y: z.number() });

export function registerOps(app: FastifyInstance, p: Platform): void {
  const o = p.ops;

  app.get('/api/ops/summary', { preHandler: requirePerm('world.view') }, async () => ({
    readiness: o.readiness,
    readinessInfo: READINESS_INFO,
    classification: p.classification,
    threats: o.threats.slice(0, 20),
    vitalAssets: o.vas,
  }));

  app.post('/api/ops/readiness', { preHandler: requirePerm('ops.readiness') }, async (req, reply) => {
    const b = parse(z.object({ level: z.enum(READINESS_LEVELS), reason: z.string().min(3).max(500) }), req.body, reply);
    if (!b) return;
    await o.setReadiness(b.level, b.reason, req.user!.username);
    await audit(p, req, 'readiness_changed', b.level, { reason: b.reason });
    return o.readiness;
  });
  app.get('/api/ops/readiness/history', { preHandler: requirePerm('world.view') }, async () => o.readinessHistory());

  app.get('/api/ops/threats', { preHandler: requirePerm('world.view') }, async () => o.threats);

  // Vital assets
  app.get('/api/ops/vital-assets', { preHandler: requirePerm('world.view') }, async () => o.vas);
  app.put('/api/ops/vital-assets', { preHandler: requirePerm('ops.readiness') }, async (req, reply) => {
    const b = parse(VaInput, req.body, reply);
    if (!b) return;
    await o.saveVa(b);
    await audit(p, req, 'vital_asset_saved', b.id, b);
    return o.vas;
  });
  app.delete('/api/ops/vital-assets/:id', { preHandler: requirePerm('ops.readiness') }, async (req) => {
    const id = (req.params as { id: string }).id;
    await o.removeVa(id);
    await audit(p, req, 'vital_asset_removed', id, {});
    return o.vas;
  });

  // Teams & tasks
  app.get('/api/ops/teams', { preHandler: requirePerm('world.view') }, async () => o.teams());
  app.post('/api/ops/teams', { preHandler: requirePerm('ops.readiness') }, async (req, reply) => {
    const b = parse(TeamInput.extend({ id: z.string().max(40).optional() }), req.body, reply);
    if (!b) return;
    const t = await o.saveTeam(b, b.id);
    await audit(p, req, 'team_saved', t.id, b);
    return t;
  });
  /**
   * Field device position: a team leader's phone (Field view) reports its GNSS fix, which enters the normal
   * ingestion pipeline as a gps.position observation from the site's GPS gateway feed — exactly as a
   * hardware tracker would. The team gets a tracker entity id on first use.
   */
  let gpsSeq = 0;
  app.post('/api/ops/teams/:id/position', { preHandler: requirePerm('ops.log'), config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(
      z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), alt: z.number().min(-500).max(9000).nullish(), accuracyM: z.number().positive().max(1000), speedMps: z.number().min(0).max(200).nullish(), headingDeg: z.number().min(0).max(360).nullish(), at: z.number().int().positive().optional() }),
      req.body,
      reply,
    );
    if (!b) return;
    const id = (req.params as { id: string }).id;
    const team = (await o.teams()).find((t) => t.id === id);
    if (!team) return reply.code(404).send({ error: 'unknown team' });
    const gps = FACILITY.sensors.find((s) => s.kind === 'gps');
    if (!gps) return reply.code(409).send({ error: 'this site has no GPS feed — add one in Site setup' });
    let entityId = team.entityId;
    if (!entityId) {
      entityId = `fd-${team.id}`.slice(0, 32);
      await o.saveTeam({ callsign: team.callsign, kind: team.kind as TeamInput['kind'], strength: team.strength, leader: team.leader, channel: team.channel, entityId, mode: team.mode, status: team.status, notes: team.notes }, team.id);
    }
    const now = Date.now();
    const observedAt = Math.min(now, b.at ?? now);
    const env = {
      schema: INGEST_SCHEMA_VERSION,
      messageId: `fld-${team.id}-${observedAt}-${gpsSeq}`,
      sensorId: gps.id,
      adapter: 'strata.field-device.v1',
      seq: gpsSeq++,
      observedAt,
      sentAt: now,
      kind: 'gps.position' as const,
      payload: {
        entityId,
        entityKind: team.mode === 'vehicle' ? ('vehicle' as const) : ('person' as const),
        callsign: team.callsign,
        role: team.kind,
        status: team.status === 'AVAILABLE' ? ('available' as const) : ('responding' as const),
        position: { lat: b.lat, lon: b.lon, alt: b.alt ?? 0 },
        accuracyM: Math.max(1, b.accuracyM),
        ...(b.speedMps != null ? { speedMps: b.speedMps } : {}),
        ...(b.headingDeg != null ? { headingDeg: b.headingDeg } : {}),
      },
    };
    const r = await p.ingest.process([env]);
    if (r.rejected.length) return reply.code(422).send({ error: 'position rejected', detail: r.rejected[0] });
    return { ok: true, entityId };
  });
  app.post('/api/ops/teams/:id/assistance', { preHandler: requirePerm('ops.log') }, async (req, reply) => {
    const b = parse(z.object({ note: z.string().max(300).default('') }), req.body ?? {}, reply);
    if (!b) return;
    try {
      const a = await o.requestAssistance((req.params as { id: string }).id, req.user!.username, b.note);
      await audit(p, req, 'assistance_requested', a.id, { team: (req.params as { id: string }).id, note: b.note });
      return a;
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.post('/api/ops/contact-report', { preHandler: requirePerm('ops.log') }, async (req, reply) => {
    const f = z.string().max(300).default('');
    const b = parse(z.object({ teamId: z.string().max(40).nullish(), size: f, activity: f, location: f, unit: f, time: f, equipment: f, position: point.nullish() }), req.body, reply);
    if (!b) return;
    try {
      const a = await o.contactReport(b.teamId ?? null, req.user!.username, { ...b, position: b.position ? { x: b.position.x, y: b.position.y, z: 0 } : null });
      await audit(p, req, 'contact_report', a.id, b);
      return a;
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.get('/api/ops/tasks', { preHandler: requirePerm('world.view') }, async (req, reply) => {
    const q = parse(z.object({ active: z.enum(['0', '1']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query, reply);
    if (!q) return;
    return o.tasks({ active: q.active === '1', limit: q.limit });
  });
  app.post('/api/ops/tasks', { preHandler: requirePerm('ops.dispatch') }, async (req, reply) => {
    const b = parse(
      z.object({
        teamId: z.string().max(40),
        alertId: z.string().max(40).nullish(),
        incidentId: z.string().max(40).nullish(),
        target: point.nullish(),
        mgrs: z.string().max(30).nullish(),
        locationText: z.string().max(200).nullish(),
        orders: z.string().min(3).max(1000),
        priority: z.enum(['critical', 'high', 'medium', 'low']).default('high'),
      }),
      req.body,
      reply,
    );
    if (!b) return;
    try {
      let target = b.target ?? null;
      if (!target && b.mgrs) {
        const g = fromMgrs(b.mgrs);
        const e = o.frame.toEnu({ lat: g.lat, lon: g.lon, alt: 0 });
        target = { x: e.x, y: e.y };
      }
      const t = await o.dispatch({ ...b, target }, req.user!.username);
      await audit(p, req, 'team_dispatched', t.id, { team: t.callsign, alert: b.alertId, orders: b.orders });
      return t;
    } catch (e) {
      if (e instanceof Error && /MGRS/.test(e.message)) return reply.code(400).send({ error: e.message });
      return err(reply, e);
    }
  });
  app.post('/api/ops/tasks/:id/status', { preHandler: requirePerm('ops.dispatch') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(z.object({ status: z.enum(TASK_STATUSES), note: z.string().max(500).optional(), outcome: z.string().max(1000).optional() }), req.body, reply);
    if (!b) return;
    try {
      const t = await o.updateTask(id, b.status, req.user!.username, b.note, b.outcome);
      await audit(p, req, 'task_updated', id, b);
      return t;
    } catch (e) {
      return err(reply, e);
    }
  });

  // Duty log
  app.get('/api/ops/log', { preHandler: requirePerm('world.view') }, async (req, reply) => {
    const q = parse(z.object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional(), kind: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(1000).default(300) }), req.query, reply);
    if (!q) return;
    return o.logEntries(q);
  });
  app.post('/api/ops/log', { preHandler: requirePerm('ops.log') }, async (req, reply) => {
    const b = parse(z.object({ text: z.string().min(2).max(2000), kind: z.enum(['manual', 'radio', 'visitor', 'patrol', 'correction']).default('manual'), ref: z.string().max(60).nullish() }), req.body, reply);
    if (!b) return;
    await o.log(b.kind, b.text, req.user!.username, b.ref ?? null);
    return { ok: true };
  });

  // Checklists
  app.get('/api/ops/checklists/:alertId', { preHandler: requirePerm('alerts.view') }, async (req, reply) => {
    const c = await o.checklist((req.params as { alertId: string }).alertId);
    return c ?? reply.code(404).send({ error: 'unknown alert' });
  });
  app.post('/api/ops/checklists/:alertId/:index', { preHandler: requirePerm('alerts.acknowledge') }, async (req, reply) => {
    const { alertId, index } = req.params as { alertId: string; index: string };
    const b = parse(z.object({ note: z.string().max(500).nullish() }), req.body ?? {}, reply);
    if (!b) return;
    try {
      await o.tick_item(alertId, Number(index), req.user!.username, b.note ?? null);
      await audit(p, req, 'checklist_item_done', alertId, { index: Number(index) });
      return o.checklist(alertId);
    } catch (e) {
      return err(reply, e);
    }
  });
  app.get('/api/ops/sops', { preHandler: requirePerm('alerts.view') }, async () => ({ overrides: o.sops, defaults: DEFAULT_SOPS }));
  app.put('/api/ops/sops', { preHandler: requirePerm('admin.config') }, async (req, reply) => {
    const b = parse(z.record(z.string().max(60), z.array(z.string().min(2).max(300)).max(30)), req.body, reply);
    if (!b) return;
    await o.saveSops(b, req.user!.username);
    await audit(p, req, 'sops_changed', 'ops.sop', { rules: Object.keys(b) });
    return { ok: true };
  });

  // Handover
  app.get('/api/ops/handover/state', { preHandler: requirePerm('ops.log') }, async () => o.handoverState());
  app.get('/api/ops/handovers', { preHandler: requirePerm('ops.log') }, async () => o.handovers());
  app.post('/api/ops/handovers', { preHandler: requirePerm('ops.log') }, async (req, reply) => {
    const b = parse(z.object({ incoming: z.string().min(1).max(64), summary: z.string().min(3).max(4000) }), req.body, reply);
    if (!b) return;
    try {
      const r = await o.createHandover(req.user!.username, b.incoming, b.summary);
      await audit(p, req, 'handover_prepared', r.id, { incoming: b.incoming });
      return r;
    } catch (e) {
      return err(reply, e);
    }
  });
  app.post('/api/ops/handovers/:id/accept', { preHandler: requirePerm('ops.log') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      await o.acknowledgeHandover(id, req.user!.username);
      await audit(p, req, 'handover_accepted', id, {});
      return { ok: true };
    } catch (e) {
      return err(reply, e);
    }
  });

  // SITREPs
  app.get('/api/ops/sitreps', { preHandler: requirePerm('incidents.view') }, async () => o.sitreps());
  app.get('/api/ops/sitreps/:id', { preHandler: requirePerm('incidents.view') }, async (req, reply) => (await o.sitrep((req.params as { id: string }).id)) ?? reply.code(404).send({ error: 'unknown SITREP' }));
  app.post('/api/ops/sitreps', { preHandler: requirePerm('incidents.edit') }, async (req, reply) => {
    const b = parse(z.object({ incidentId: z.string().max(40).nullish(), from: z.number().int().optional(), to: z.number().int().optional(), classification: z.enum(['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET']).default('RESTRICTED') }), req.body, reply);
    if (!b) return;
    const s = await o.draftSitrep(b, req.user!.username);
    await audit(p, req, 'sitrep_drafted', s.id, { incident: b.incidentId ?? null });
    return s;
  });
  app.put('/api/ops/sitreps/:id', { preHandler: requirePerm('incidents.edit') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = parse(z.object({ sections: z.array(z.object({ key: z.string().max(30), title: z.string().max(80), text: z.string().max(20000) })).max(20), classification: z.enum(['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET']) }), req.body, reply);
    if (!b) return;
    try {
      return await o.editSitrep(id, b.sections, b.classification);
    } catch (e) {
      return err(reply, e);
    }
  });
  app.post('/api/ops/sitreps/:id/issue', { preHandler: requirePerm('ops.readiness') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const s = await o.issueSitrep(id, req.user!.username);
      await audit(p, req, 'sitrep_issued', id, { number: s.number, version: s.version });
      return s;
    } catch (e) {
      return err(reply, e);
    }
  });
  app.post('/api/ops/sitreps/:id/amend', { preHandler: requirePerm('incidents.edit') }, async (req, reply) => {
    try {
      return await o.amendSitrep((req.params as { id: string }).id, req.user!.username);
    } catch (e) {
      return err(reply, e);
    }
  });

  // Classification banner
  app.put('/api/ops/classification', { preHandler: requirePerm('admin.config') }, async (req, reply) => {
    const b = parse(z.object({ level: z.enum(['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET']), caveat: z.string().max(60).default('') }), req.body, reply);
    if (!b) return;
    await p.setClassification(b, req.user!.username);
    await audit(p, req, 'classification_changed', b.level, b);
    return p.classification;
  });
}
