import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CLASSIFICATIONS, CONFIDENCE_LEVELS, DOCUMENT_KINDS, ORGANISATION_PATTERN } from '@strata/domain';
import type { Platform } from '../platform.ts';
import { audit, parse, requirePerm } from '../http/guards.ts';
import { DocumentError, type Actor } from '../documents/documentService.ts';

const IdParams = z.object({ id: z.string().min(1).max(40) });
const Upload = z.object({
  title: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(200),
  kind: z.enum(DOCUMENT_KINDS),
  text: z.string().max(1_000_000),
  classification: z.enum(CLASSIFICATIONS).optional(),
  owner: z.string().regex(ORGANISATION_PATTERN).optional(),
  sharedWith: z.array(z.string().regex(ORGANISATION_PATTERN)).max(8).optional(),
  documentDate: z.number().int().nonnegative().nullish(),
});
const Assess = z.object({ confidence: z.enum(CONFIDENCE_LEVELS), note: z.string().trim().max(400).optional() });

const actorOf = (req: FastifyRequest): Actor => ({ clearance: req.user!.clearance, organisation: req.user!.organisation, role: req.user!.role, username: req.user!.username });

async function run<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DocumentError) return reply.code(e.status).send(e.problems ? { error: e.message, problems: e.problems } : { error: e.message });
    throw e;
  }
}

/** Document library: ingestion, full-text search and the analyst's confidence label. */
export function registerDocuments(app: FastifyInstance, p: Platform): void {
  const svc = p.documents;

  app.get('/api/documents', { preHandler: requirePerm('documents.view') }, async (req) => svc.search('', actorOf(req)));

  /** Full-text search. Results are limited to what the person may see; excerpts show the matched words. */
  app.get('/api/documents/search', { preHandler: requirePerm('documents.view') }, async (req, reply) => {
    const q = parse(z.object({ q: z.string().max(200).optional() }), req.query ?? {}, reply);
    if (!q) return;
    return run(reply, () => svc.search(q.q ?? '', actorOf(req)));
  });

  app.get('/api/documents/:id', { preHandler: requirePerm('documents.view') }, async (req, reply) => {
    const { id } = parse(IdParams, req.params, reply) ?? { id: '' };
    if (!id) return;
    return run(reply, () => svc.get(id, actorOf(req)));
  });

  app.post('/api/documents', { preHandler: requirePerm('documents.upload') }, async (req, reply) => {
    const b = parse(Upload, req.body, reply);
    if (!b) return;
    return run(reply, async () => {
      const d = await svc.upload({ ...b, documentDate: b.documentDate ?? null }, actorOf(req));
      await audit(p, req, 'document_ingested', d.id, { kind: d.kind, classification: d.classification, owner: d.owner, rows: d.rows });
      return d;
    });
  });

  /** An analyst's assessment of a document, by someone other than its uploader. */
  app.patch('/api/documents/:id/confidence', { preHandler: requirePerm('documents.review') }, async (req, reply) => {
    const { id } = parse(IdParams, req.params, reply) ?? { id: '' };
    const b = parse(Assess, req.body, reply);
    if (!id || !b) return;
    return run(reply, async () => {
      const d = await svc.assess(id, b.confidence, b.note ?? null, actorOf(req));
      await audit(p, req, 'document_assessed', d.id, { confidence: b.confidence });
      return d;
    });
  });
}
