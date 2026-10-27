import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Subject } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { audit, parse, requirePerm } from '../http/guards.ts';
import { RecordError, RECORD_KINDS } from '../records/records.ts';
import { MAX_LINK_DEPTH } from '../records/linkGraph.ts';

const RecordParams = z.object({ kind: z.enum(RECORD_KINDS), id: z.string().min(1).max(40) });
const Comment = z.object({ body: z.string().trim().min(1).max(2000) });
const LinkQuery = z.object({ depth: z.coerce.number().int().min(1).max(MAX_LINK_DEPTH).default(1) });

const subjectOf = (req: FastifyRequest): Subject & { username: string } => ({
  clearance: req.user!.clearance,
  organisation: req.user!.organisation,
  role: req.user!.role,
  username: req.user!.username,
});

/** Maps a visibility or validation refusal to its status; anything else is a server fault and is not disclosed. */
async function run<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RecordError) return reply.code(e.status).send({ error: e.message });
    throw e;
  }
}

/** Record discussion and link analysis, for any record a person may see. */
export function registerRecords(app: FastifyInstance, p: Platform): void {
  app.get('/api/records/:kind/:id/comments', { preHandler: requirePerm('incidents.view') }, async (req, reply) => {
    const params = parse(RecordParams, req.params, reply);
    if (!params) return;
    return run(reply, () => p.recordComments.list(params.kind, params.id, subjectOf(req)));
  });

  app.post('/api/records/:kind/:id/comments', { preHandler: requirePerm('records.comment') }, async (req, reply) => {
    const params = parse(RecordParams, req.params, reply);
    const b = parse(Comment, req.body, reply);
    if (!params || !b) return;
    return run(reply, async () => {
      const c = await p.recordComments.add(params.kind, params.id, b.body, subjectOf(req));
      await audit(p, req, 'record_comment_added', `${params.kind}:${params.id}`, { length: b.body.length });
      return c;
    });
  });

  app.get('/api/records/:kind/:id/links', { preHandler: requirePerm('incidents.view') }, async (req, reply) => {
    const params = parse(RecordParams, req.params, reply);
    const q = parse(LinkQuery, req.query, reply);
    if (!params || !q) return;
    return run(reply, () => p.links.around(params.kind, params.id, q.depth, subjectOf(req)));
  });
}
