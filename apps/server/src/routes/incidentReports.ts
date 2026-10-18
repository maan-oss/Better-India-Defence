import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CLASSIFICATIONS, REPORT_KINDS, REPORT_STATES, can, type Permission, type ReportState } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { audit, parse, requirePerm } from '../http/guards.ts';
import { ReportError, type Actor } from '../incidentReports/reportService.ts';

const IdParams = z.object({ id: z.string().min(1).max(40) });
const Create = z.object({
  title: z.string().trim().min(3).max(160),
  kind: z.enum(REPORT_KINDS),
  description: z.string().trim().min(1).max(4000),
  classification: z.enum(CLASSIFICATIONS).optional(),
  assetIds: z.array(z.string().min(1).max(40)).max(20).optional(),
});
const Link = z.object({ assetId: z.string().min(1).max(40) });
const Transition = z.object({
  to: z.enum(REPORT_STATES.filter((s) => s !== 'reported') as [Exclude<ReportState, 'reported'>, ...Exclude<ReportState, 'reported'>[]]),
  note: z.string().trim().max(1000).optional(),
});
const Review = z.object({ summary: z.string().trim().min(1).max(4000), lessons: z.string().trim().max(4000).optional() });

/** The permission each step needs: verification and review are analyst acts; the rest are operator acts. */
const STEP_PERMISSION: Record<ReportState, Permission> = {
  reported: 'incidents.create',
  verified: 'reports.verify',
  escalated: 'incidents.edit',
  responding: 'incidents.edit',
  resolved: 'incidents.edit',
  reviewed: 'reports.review',
};

const actorOf = (req: FastifyRequest): Actor => ({
  clearance: req.user!.clearance,
  organisation: req.user!.organisation,
  role: req.user!.role,
  username: req.user!.username,
});

/** Maps a service refusal to its status; anything else is a server fault and is not disclosed. */
async function run<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ReportError) return reply.code(e.status).send({ error: e.message });
    throw e;
  }
}

/** Incident reports: report, verify, escalate, respond, resolve and review, with the history of every step. */
export function registerIncidentReports(app: FastifyInstance, p: Platform): void {
  const svc = p.reports;

  app.get('/api/incident-reports', { preHandler: requirePerm('incidents.view') }, async (req) => svc.list(actorOf(req)));

  app.get('/api/incident-reports/:id', { preHandler: requirePerm('incidents.view') }, async (req, reply) => {
    const { id } = parse(IdParams, req.params, reply) ?? { id: '' };
    if (!id) return;
    return run(reply, () => svc.get(id, actorOf(req)));
  });

  app.post('/api/incident-reports', { preHandler: requirePerm('incidents.create') }, async (req, reply) => {
    const b = parse(Create, req.body, reply);
    if (!b) return;
    return run(reply, async () => {
      const r = await svc.create(b, actorOf(req));
      await audit(p, req, 'incident_report_created', r.code, { kind: b.kind, classification: r.classification, assets: r.assets.map((a) => a.tag) });
      return r;
    });
  });

  app.post('/api/incident-reports/:id/assets', { preHandler: requirePerm('incidents.edit') }, async (req, reply) => {
    const { id } = parse(IdParams, req.params, reply) ?? { id: '' };
    const b = parse(Link, req.body, reply);
    if (!id || !b) return;
    return run(reply, async () => {
      const r = await svc.link(id, b.assetId, actorOf(req));
      await audit(p, req, 'incident_report_linked', r.code, { assetId: b.assetId });
      return r;
    });
  });

  app.post('/api/incident-reports/:id/transition', async (req, reply) => {
    const { id } = parse(IdParams, req.params, reply) ?? { id: '' };
    const b = parse(Transition, req.body, reply);
    if (!id || !b) return;
    if (!can(req.user!.role, STEP_PERMISSION[b.to])) return reply.code(403).send({ error: `role ${req.user!.role} lacks permission ${STEP_PERMISSION[b.to]}` });
    return run(reply, async () => {
      const r = await svc.transition(id, b.to, b.note ?? null, actorOf(req));
      await audit(p, req, `incident_report_${b.to}`, r.code, { note: b.note ?? null, level: r.level });
      return r;
    });
  });

  /** The post-incident review: the last step, by someone other than the person who resolved the incident. */
  app.post('/api/incident-reports/:id/review', { preHandler: requirePerm('reports.review') }, async (req, reply) => {
    const { id } = parse(IdParams, req.params, reply) ?? { id: '' };
    const b = parse(Review, req.body, reply);
    if (!id || !b) return;
    return run(reply, async () => {
      const r = await svc.transition(id, 'reviewed', null, actorOf(req), { summary: b.summary, lessons: b.lessons ?? null });
      await audit(p, req, 'incident_report_reviewed', r.code, {});
      return r;
    });
  });
}
