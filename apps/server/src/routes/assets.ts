import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AssetInput, AssetPatch, CompleteInput, DependencyInput, ImpactQuery, PlanInput, RetireInput, StatusInput, access, mayCreateAt, type AssetView, type Action, type Subject } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { audit, parse, requirePerm } from '../http/guards.ts';
import { AssetError } from '../assets/assetService.ts';

const IdParams = z.object({ id: z.string().min(1).max(40) });
const PlanParams = IdParams.extend({ planId: z.string().min(1).max(40) });

/** Who is asking, for the clearance and organisation rule. */
const subjectOf = (req: FastifyRequest): Subject => ({ clearance: req.user!.clearance, organisation: req.user!.organisation, role: req.user!.role });

const REFUSALS = {
  organisation: 'this record belongs to another organisation',
  clearance: 'your clearance does not cover this record',
  'owner-only': 'only the owning organisation can change this record',
  'administrator-only': 'only an administrator can transfer a record to another organisation',
} as const;

/**
 * Loads an asset the person may act on. A record they cannot see is reported as unknown, exactly like a missing one, so
 * its existence is not revealed. A record they can see but may not change is refused with the reason.
 */
async function authorised(req: FastifyRequest, reply: FastifyReply, a: Platform['assets'], id: string, action: Action): Promise<AssetView | null> {
  let asset: AssetView;
  try {
    asset = (await a.detail(id)).asset;
  } catch (e) {
    if (e instanceof AssetError) {
      await reply.code(e.status).send({ error: e.message });
      return null;
    }
    throw e;
  }
  const s = subjectOf(req);
  if (!access(s, asset, 'view').allowed) {
    await reply.code(404).send({ error: 'unknown asset' });
    return null;
  }
  const d = access(s, asset, action);
  if (!d.allowed) {
    await reply.code(403).send({ error: REFUSALS[d.reason] });
    return null;
  }
  return asset;
}

/** The register's views, keyed by id, for the ones the person may see. Used to filter relations without revealing others. */
async function visibleById(req: FastifyRequest, a: Platform['assets']): Promise<Map<string, AssetView>> {
  const s = subjectOf(req);
  return new Map((await a.list()).filter((v) => access(s, v, 'view').allowed).map((v) => [v.id, v]));
}

/** The asset id a route refers to (by id or tag), or null after a 400 or 404 has been sent. */
async function assetId(req: FastifyRequest, reply: FastifyReply, a: Platform['assets']): Promise<string | null> {
  const ref = parse(IdParams, req.params, reply)?.id;
  if (!ref) return null;
  try {
    return await a.resolveId(ref);
  } catch (e) {
    if (e instanceof AssetError) {
      await reply.code(e.status).send({ error: e.message });
      return null;
    }
    throw e;
  }
}

/** Maps a service refusal to its HTTP status; anything else is a server fault and is not disclosed. */
async function run(reply: FastifyReply, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AssetError) return reply.code(e.status).send({ error: e.message });
    throw e;
  }
}

/** Asset and infrastructure register: inventory, dependencies, impact analysis and maintenance. */
export function registerAssets(app: FastifyInstance, p: Platform): void {
  const a = p.assets;

  app.get('/api/assets', { preHandler: requirePerm('assets.view') }, async (req) => {
    const s = subjectOf(req);
    return (await a.list()).filter((v) => access(s, v, 'view').allowed);
  });

  app.get('/api/assets/:id', { preHandler: requirePerm('assets.view') }, async (req, reply) => {
    const id = await assetId(req, reply, a);
    if (!id) return;
    if (!(await authorised(req, reply, a, id, 'view'))) return;
    const d = await a.detail(id);
    // Relations the person may not see are withheld and counted, not named.
    const visible = await visibleById(req, a);
    const upstream = d.upstream.filter((u) => visible.has(u.id));
    const dependents = d.dependents.filter((u) => visible.has(u.id));
    return { ...d, upstream, dependents, withheld: { upstream: d.upstream.length - upstream.length, dependents: d.dependents.length - dependents.length } };
  });

  /** What would change if this asset were set to the given status. Read-only. Withheld impacts are counted. */
  app.get('/api/assets/:id/impact', { preHandler: requirePerm('assets.view') }, async (req, reply) => {
    const id = await assetId(req, reply, a);
    if (!id) return;
    const q = parse(ImpactQuery, req.query ?? {}, reply);
    if (!q) return;
    if (!(await authorised(req, reply, a, id, 'view'))) return;
    const impact = await a.impact(id, q.status);
    const visible = await visibleById(req, a);
    const rows = impact.rows.filter((r) => visible.has(r.id));
    return { ...impact, rows, withheld: impact.rows.length - rows.length };
  });

  app.post('/api/assets', { preHandler: requirePerm('assets.edit') }, async (req, reply) => {
    const b = parse(AssetInput, req.body, reply);
    if (!b) return;
    const s = subjectOf(req);
    // A record is created at or below the creator's clearance, and belongs to the creator's organisation unless an
    // administrator names another one.
    if (!mayCreateAt(s, b.classification ?? 'UNCLASSIFIED')) return reply.code(403).send({ error: 'the classification is above your clearance' });
    if (b.owner && b.owner !== s.organisation && s.role !== 'administrator') return reply.code(403).send({ error: 'only an administrator can create a record for another organisation' });
    const input = { ...b, classification: b.classification ?? 'UNCLASSIFIED', owner: b.owner ?? s.organisation, sharedWith: b.sharedWith ?? [] };
    return run(reply, async () => {
      const d = await a.create(input, req.user!.username);
      await audit(p, req, 'asset_created', d.asset.id, { tag: b.tag, category: b.category, criticality: b.criticality, classification: input.classification, owner: input.owner });
      return d;
    });
  });

  app.patch('/api/assets/:id', { preHandler: requirePerm('assets.edit') }, async (req, reply) => {
    const id = await assetId(req, reply, a);
    if (!id) return;
    const b = parse(AssetPatch, req.body, reply);
    if (!b) return;
    const current = await authorised(req, reply, a, id, 'change');
    if (!current) return;
    const s = subjectOf(req);
    if (b.classification && !mayCreateAt(s, b.classification)) return reply.code(403).send({ error: 'the classification is above your clearance' });
    if (b.owner && b.owner !== current.owner && !access(s, current, 'transfer').allowed) return reply.code(403).send({ error: REFUSALS['administrator-only'] });
    return run(reply, async () => {
      const d = await a.update(id, b, req.user!.username);
      await audit(p, req, 'asset_updated', id, { fields: Object.keys(b) });
      return d;
    });
  });

  app.post('/api/assets/:id/status', { preHandler: requirePerm('assets.edit') }, async (req, reply) => {
    const id = await assetId(req, reply, a);
    if (!id) return;
    const b = parse(StatusInput, req.body, reply);
    if (!b) return;
    if (!(await authorised(req, reply, a, id, 'change'))) return;
    return run(reply, async () => {
      const d = await a.setStatus(id, b.status, b.reason, req.user!.username);
      await audit(p, req, 'asset_status_changed', id, { status: b.status, reason: b.reason });
      return d;
    });
  });

  /** Replaces the dependencies of an asset. Analyst rights: this changes what every impact analysis reports. */
  app.put('/api/assets/:id/dependencies', { preHandler: requirePerm('assets.graph') }, async (req, reply) => {
    const id = await assetId(req, reply, a);
    if (!id) return;
    const b = parse(DependencyInput, req.body, reply);
    if (!b) return;
    if (!(await authorised(req, reply, a, id, 'change'))) return;
    // A dependency on a record the person cannot see is refused as an unknown asset, the same as a missing one.
    const visible = await visibleById(req, a);
    if (b.dependsOn.some((d) => !visible.has(d.id))) return reply.code(400).send({ error: 'a dependency names an unknown asset' });
    return run(reply, async () => {
      const d = await a.setDependencies(id, b.dependsOn, req.user!.username);
      await audit(p, req, 'asset_dependencies_changed', id, { dependsOn: b.dependsOn });
      return d;
    });
  });

  app.post('/api/assets/:id/plans', { preHandler: requirePerm('assets.edit') }, async (req, reply) => {
    const id = await assetId(req, reply, a);
    if (!id) return;
    const b = parse(PlanInput, req.body, reply);
    if (!b) return;
    if (!(await authorised(req, reply, a, id, 'change'))) return;
    return run(reply, async () => {
      const d = await a.addPlan(id, b, req.user!.username);
      await audit(p, req, 'asset_plan_added', id, { title: b.title, intervalDays: b.intervalDays });
      return d;
    });
  });

  app.post('/api/assets/:id/plans/:planId/complete', { preHandler: requirePerm('assets.edit') }, async (req, reply) => {
    const params = parse(PlanParams, req.params, reply);
    if (!params) return;
    const id = await assetId(req, reply, a);
    if (!id) return;
    const b = parse(CompleteInput, req.body ?? {}, reply);
    if (!b) return;
    if (!(await authorised(req, reply, a, id, 'change'))) return;
    return run(reply, async () => {
      const d = await a.completePlan(id, params.planId, b.note ?? null, req.user!.username);
      await audit(p, req, 'asset_maintenance_completed', id, { planId: params.planId });
      return d;
    });
  });

  /** Retirement is final and refused while active assets still depend on the asset. Analyst rights. */
  app.post('/api/assets/:id/retire', { preHandler: requirePerm('assets.graph') }, async (req, reply) => {
    const id = await assetId(req, reply, a);
    if (!id) return;
    const b = parse(RetireInput, req.body, reply);
    if (!b) return;
    if (!(await authorised(req, reply, a, id, 'change'))) return;
    return run(reply, async () => {
      const d = await a.retire(id, b.reason, req.user!.username);
      await audit(p, req, 'asset_retired', id, { reason: b.reason });
      return d;
    });
  });
}
