import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AssetInput, AssetPatch, CompleteInput, DependencyInput, ImpactQuery, PlanInput, RetireInput, StatusInput } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { audit, parse, requirePerm } from '../http/guards.ts';
import { AssetError } from '../assets/assetService.ts';

const IdParams = z.object({ id: z.string().min(1).max(40) });
const PlanParams = IdParams.extend({ planId: z.string().min(1).max(40) });

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

  app.get('/api/assets', { preHandler: requirePerm('assets.view') }, async () => a.list());

  app.get('/api/assets/:id', { preHandler: requirePerm('assets.view') }, async (req, reply) => {
    const id = await assetId(req, reply, a);
    if (!id) return;
    return run(reply, () => a.detail(id));
  });

  /** What would change if this asset were set to the given status. Read-only. */
  app.get('/api/assets/:id/impact', { preHandler: requirePerm('assets.view') }, async (req, reply) => {
    const id = await assetId(req, reply, a);
    if (!id) return;
    const q = parse(ImpactQuery, req.query ?? {}, reply);
    if (!q) return;
    return run(reply, () => a.impact(id, q.status));
  });

  app.post('/api/assets', { preHandler: requirePerm('assets.edit') }, async (req, reply) => {
    const b = parse(AssetInput, req.body, reply);
    if (!b) return;
    return run(reply, async () => {
      const d = await a.create(b, req.user!.username);
      await audit(p, req, 'asset_created', d.asset.id, { tag: b.tag, category: b.category, criticality: b.criticality });
      return d;
    });
  });

  app.patch('/api/assets/:id', { preHandler: requirePerm('assets.edit') }, async (req, reply) => {
    const id = await assetId(req, reply, a);
    if (!id) return;
    const b = parse(AssetPatch, req.body, reply);
    if (!b) return;
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
    return run(reply, async () => {
      const d = await a.addPlan(id, b, req.user!.username);
      await audit(p, req, 'asset_plan_added', id, { title: b.title, intervalDays: b.intervalDays });
      return d;
    });
  });

  app.post('/api/assets/:id/plans/:planId/complete', { preHandler: requirePerm('assets.edit') }, async (req, reply) => {
    const params = parse(PlanParams, req.params, reply);
    if (!params) return;
    const b = parse(CompleteInput, req.body ?? {}, reply);
    if (!b) return;
    return run(reply, async () => {
      const id = await a.resolveId(params.id);
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
    return run(reply, async () => {
      const d = await a.retire(id, b.reason, req.user!.username);
      await audit(p, req, 'asset_retired', id, { reason: b.reason });
      return d;
    });
  });
}
