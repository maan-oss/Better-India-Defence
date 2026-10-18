import { randomUUID } from 'node:crypto';
import { CLASSIFICATIONS, CONFIDENCE_LEVELS, access, classificationRank, ingestText, mayCreateAt, type Classification, type Confidence, type DocumentKind, type Subject } from '@strata/domain';
import type { Db } from '../db/client.ts';

export class DocumentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problems?: string[],
  ) {
    super(message);
  }
}

export type Actor = Subject & { username: string };

export interface DocumentView {
  id: string;
  title: string;
  source: string;
  kind: DocumentKind;
  rows: number | null;
  classification: Classification;
  owner: string;
  sharedWith: string[];
  documentDate: number | null;
  uploadedBy: string;
  uploadedAt: number;
  confidence: Confidence;
  confidenceNote: string | null;
  confidenceBy: string | null;
  confidenceAt: number | null;
}

export interface SearchHit extends DocumentView {
  /** Matching text with the matched words in [[double brackets]]; the client shows it as text, never as markup. */
  excerpt: string;
  rank: number;
}

interface Row {
  id: string;
  title: string;
  source: string;
  kind: DocumentKind;
  rows: number | null;
  classification: Classification;
  owner: string;
  shared_with: string[];
  document_date: number | null;
  uploaded_by: string;
  uploaded_at: number;
  confidence: Confidence;
  confidence_note: string | null;
  confidence_by: string | null;
  confidence_at: number | null;
}

const COLUMNS = 'id, title, source, kind, rows, classification, owner, shared_with, document_date, uploaded_by, uploaded_at, confidence, confidence_note, confidence_by, confidence_at';

const view = (r: Row): DocumentView => ({
  id: r.id,
  title: r.title,
  source: r.source,
  kind: r.kind,
  rows: r.rows === null ? null : Number(r.rows),
  classification: r.classification,
  owner: r.owner,
  sharedWith: [...(r.shared_with ?? [])],
  documentDate: r.document_date === null ? null : Number(r.document_date),
  uploadedBy: r.uploaded_by,
  uploadedAt: Number(r.uploaded_at),
  confidence: r.confidence,
  confidenceNote: r.confidence_note,
  confidenceBy: r.confidence_by,
  confidenceAt: r.confidence_at === null ? null : Number(r.confidence_at),
});

/** The classifications a person may see, lowest first: the SQL filter, and the same rule as access(). */
const reachable = (s: Subject): Classification[] => CLASSIFICATIONS.slice(0, classificationRank(s.clearance) + 1);

/** Documents: ingestion with checks, attribution, full-text search with excerpts, and an analyst's confidence label. */
export class DocumentService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private async one(id: string): Promise<Row> {
    return (await this.db.query<Row>(`SELECT ${COLUMNS} FROM documents WHERE id = $1`, [id])).rows[0]!;
  }

  async upload(
    input: { title: string; source: string; kind: DocumentKind; text: string; classification?: Classification; owner?: string; sharedWith?: string[]; documentDate?: number | null },
    actor: Actor,
  ): Promise<DocumentView> {
    const classification = input.classification ?? 'UNCLASSIFIED';
    if (!mayCreateAt(actor, classification)) throw new DocumentError('the classification is above your clearance', 403);
    const owner = input.owner ?? actor.organisation;
    if (owner !== actor.organisation && actor.role !== 'administrator') throw new DocumentError('only an administrator can file a document for another organisation', 403);
    const ingested = ingestText(input.kind, input.text);
    if (ingested.problems.length) throw new DocumentError('the document was refused', 400, ingested.problems);
    const id = `doc-${randomUUID().slice(0, 12)}`;
    await this.db.query(
      `INSERT INTO documents (id, title, source, kind, body, rows, classification, owner, shared_with, document_date, uploaded_by, uploaded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, input.title.trim(), input.source.trim(), input.kind, ingested.text, ingested.rows, classification, owner, input.sharedWith ?? [], input.documentDate ?? null, actor.username, this.now()],
    );
    return view(await this.one(id));
  }

  /** Full-text search over the documents the person may see. Results carry where the text came from and who loaded it. */
  async search(q: string, actor: Actor, limit = 50): Promise<SearchHit[]> {
    const query = q.trim();
    const lowest = reachable(actor);
    if (query === '') {
      const rows = (
        await this.db.query<Row>(`SELECT ${COLUMNS} FROM documents WHERE classification = ANY($1) AND (owner = $2 OR $2 = ANY(shared_with)) ORDER BY uploaded_at DESC LIMIT $3`, [lowest, actor.organisation, limit])
      ).rows;
      return rows.map((r) => ({ ...view(r), excerpt: '', rank: 0 }));
    }
    const rows = (
      await this.db.query<Row & { excerpt: string; rank: number }>(
        `SELECT ${COLUMNS.split(', ').map((c) => `d.${c}`).join(', ')},
                ts_headline('english', d.body, s.query, 'StartSel=[[, StopSel=]], MaxFragments=2, MaxWords=18, MinWords=6') AS excerpt,
                ts_rank(d.search, s.query) AS rank
         FROM documents d, websearch_to_tsquery('english', $1) AS s(query)
         WHERE d.search @@ s.query AND d.classification = ANY($2) AND (d.owner = $3 OR $3 = ANY(d.shared_with))
         ORDER BY rank DESC, d.uploaded_at DESC LIMIT $4`,
        [query, lowest, actor.organisation, limit],
      )
    ).rows;
    return rows.map((r) => ({ ...view(r), excerpt: r.excerpt, rank: Number(r.rank) }));
  }

  async get(id: string, actor: Actor): Promise<DocumentView & { body: string }> {
    const r = (await this.db.query<Row & { body: string }>(`SELECT ${COLUMNS}, body FROM documents WHERE id = $1`, [id])).rows[0];
    if (!r || !access(actor, { classification: r.classification, owner: r.owner, sharedWith: r.shared_with }, 'view').allowed) throw new DocumentError('unknown document', 404);
    return { ...view(r), body: r.body };
  }

  /**
   * The analyst's assessment of the content. Someone other than the uploader makes it, so nobody confirms their own
   * material. The latest assessment, with the person and the time, is kept with the document.
   */
  async assess(id: string, confidence: Confidence, note: string | null, actor: Actor): Promise<DocumentView> {
    const r = (await this.db.query<Row>(`SELECT ${COLUMNS} FROM documents WHERE id = $1`, [id])).rows[0];
    if (!r || !access(actor, { classification: r.classification, owner: r.owner, sharedWith: r.shared_with }, 'view').allowed) throw new DocumentError('unknown document', 404);
    if (r.uploaded_by === actor.username) throw new DocumentError('the person who uploaded a document cannot assess it', 403);
    if (!CONFIDENCE_LEVELS.includes(confidence)) throw new DocumentError('unknown confidence label', 400);
    await this.db.query('UPDATE documents SET confidence = $2, confidence_note = $3, confidence_by = $4, confidence_at = $5 WHERE id = $1', [id, confidence, note, actor.username, this.now()]);
    return view(await this.one(id));
  }
}
