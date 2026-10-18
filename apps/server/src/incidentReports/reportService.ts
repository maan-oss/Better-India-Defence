import { randomUUID } from 'node:crypto';
import {
  REFUSAL_TEXT,
  REPORT_STEPS,
  access,
  escalationFor,
  mayCreateAt,
  stepRefusal,
  type Classification,
  type EscalationLevel,
  type ReportKind,
  type ReportState,
  type Subject,
} from '@strata/domain';
import type { Db, Queryable } from '../db/client.ts';

/** A refusal the caller can show: the HTTP status and a sentence an operator can act on. */
export class ReportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface ReportRow {
  id: string;
  code: string;
  title: string;
  kind: ReportKind;
  description: string;
  state: ReportState;
  classification: Classification;
  owner: string;
  reported_by: string;
  reported_at: number;
  verified_by: string | null;
  verified_at: number | null;
  resolved_by: string | null;
  resolved_at: number | null;
  resolution: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  review_summary: string | null;
  lessons: string | null;
}

export interface LinkedAsset {
  id: string;
  tag: string;
  name: string;
  criticality: number;
  classification: Classification;
  owner: string;
  shared_with: string[];
}

export interface ReportView {
  id: string;
  code: string;
  title: string;
  kind: ReportKind;
  description: string;
  state: ReportState;
  classification: Classification;
  owner: string;
  reportedBy: string;
  reportedAt: number;
  verifiedBy: string | null;
  verifiedAt: number | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  resolution: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewSummary: string | null;
  lessons: string | null;
  /** The escalation the linked equipment requires. */
  level: EscalationLevel;
  assets: { id: string; tag: string; name: string; criticality: number }[];
  /** The steps this person may take now, from the lifecycle and the rules about who may take them. */
  nextSteps: ReportState[];
}

export interface ReportEvent {
  id: number;
  t: number;
  kind: string;
  detail: Record<string, unknown>;
  actor: string;
}

/** Who is acting: the clearance and organisation rule needs the role; the history records the username. */
export type Actor = Subject & { username: string };

/** A report is shared with no organisation: only its owner can see or change it. */
const resourceOf = (r: ReportRow) => ({ classification: r.classification, owner: r.owner, sharedWith: [] as string[] });

const DAY_MS = 86_400_000;
const stamp = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

/**
 * Incident reports. Visibility and change follow the clearance and organisation rule: a report carries the classification
 * and owner of the organisation that reported it, and a report the person cannot see is reported as unknown.
 */
export class IncidentReportService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private async row(id: string): Promise<ReportRow | null> {
    return (await this.db.query<ReportRow>('SELECT * FROM incident_reports WHERE id = $1', [id])).rows[0] ?? null;
  }

  private async linkedAssets(id: string): Promise<LinkedAsset[]> {
    return (
      await this.db.query<LinkedAsset>(
        'SELECT a.id, a.tag, a.name, a.criticality, a.classification, a.owner, a.shared_with FROM incident_report_assets l JOIN assets a ON a.id = l.asset_id WHERE l.report_id = $1 ORDER BY a.criticality DESC, a.tag',
        [id],
      )
    ).rows.map((r) => ({ ...r, criticality: Number(r.criticality) }));
  }

  private async view(r: ReportRow, subject: Actor): Promise<ReportView> {
    const assets = await this.linkedAssets(r.id);
    const level = escalationFor(assets.map((a) => a.criticality));
    const nextSteps = REPORT_STEPS[r.state].filter((to) => {
      if (!access(subject, resourceOf(r), 'change').allowed) return false;
      return stepRefusal({ from: r.state, to, level, actor: subject.username, reportedBy: r.reported_by, resolvedBy: r.resolved_by }) === null;
    });
    return {
      id: r.id,
      code: r.code,
      title: r.title,
      kind: r.kind,
      description: r.description,
      state: r.state,
      classification: r.classification,
      owner: r.owner,
      reportedBy: r.reported_by,
      reportedAt: Number(r.reported_at),
      verifiedBy: r.verified_by,
      verifiedAt: r.verified_at === null ? null : Number(r.verified_at),
      resolvedBy: r.resolved_by,
      resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at),
      resolution: r.resolution,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at === null ? null : Number(r.reviewed_at),
      reviewSummary: r.review_summary,
      lessons: r.lessons,
      level,
      assets: assets.map((a) => ({ id: a.id, tag: a.tag, name: a.name, criticality: a.criticality })),
      nextSteps,
    };
  }

  /** Reports the person may see, newest first. */
  async list(subject: Actor): Promise<ReportView[]> {
    const rows = (await this.db.query<ReportRow>('SELECT * FROM incident_reports ORDER BY reported_at DESC LIMIT 500')).rows;
    const visible = rows.filter((r) => access(subject, resourceOf(r), 'view').allowed);
    return Promise.all(visible.map((r) => this.view(r, subject)));
  }

  /** One report and its history. A report the person cannot see is unknown. */
  async get(id: string, subject: Actor): Promise<{ report: ReportView; events: ReportEvent[] }> {
    const r = await this.row(id);
    if (!r || !access(subject, resourceOf(r), 'view').allowed) throw new ReportError('unknown incident report', 404);
    const events = (await this.db.query<{ id: string; t: number; kind: string; detail: Record<string, unknown>; actor: string }>('SELECT id, t, kind, detail, actor FROM incident_report_events WHERE report_id = $1 ORDER BY id', [id])).rows;
    return { report: await this.view(r, subject), events: events.map((e) => ({ id: Number(e.id), t: Number(e.t), kind: e.kind, detail: e.detail, actor: e.actor })) };
  }

  /** Visible asset records that a report may be linked to, by id. */
  private async assertVisibleAssets(ids: string[], subject: Subject, q: Queryable): Promise<void> {
    for (const id of ids) {
      const a = (await q.query<{ id: string; classification: Classification; owner: string; shared_with: string[] }>('SELECT id, classification, owner, shared_with FROM assets WHERE id = $1', [id])).rows[0];
      if (!a || !access(subject, { classification: a.classification, owner: a.owner, sharedWith: a.shared_with }, 'view').allowed) {
        throw new ReportError('a linked asset is unknown', 400);
      }
    }
  }

  async create(
    input: { title: string; kind: ReportKind; description: string; classification?: Classification; assetIds?: string[] },
    subject: Actor,
  ): Promise<ReportView> {
    const classification = input.classification ?? 'UNCLASSIFIED';
    if (!mayCreateAt(subject, classification)) throw new ReportError('the classification is above your clearance', 403);
    const id = `irp-${randomUUID().slice(0, 12)}`;
    const t = this.now();
    await this.db.transaction(async (q) => {
      await this.assertVisibleAssets(input.assetIds ?? [], subject, q);
      const today = (await q.query<{ n: number }>('SELECT count(*)::int AS n FROM incident_reports WHERE reported_at >= $1', [Math.floor(t / DAY_MS) * DAY_MS])).rows[0]!.n;
      const code = `IR-${stamp(t)}-${String(today + 1).padStart(3, '0')}`;
      await q.query(
        `INSERT INTO incident_reports (id, code, title, kind, description, state, classification, owner, reported_by, reported_at)
         VALUES ($1,$2,$3,$4,$5,'reported',$6,$7,$8,$9)`,
        [id, code, input.title, input.kind, input.description, classification, subject.organisation, subject.username, t],
      );
      for (const assetId of input.assetIds ?? []) {
        await q.query('INSERT INTO incident_report_assets (report_id, asset_id, linked_by, linked_at) VALUES ($1,$2,$3,$4)', [id, assetId, subject.username, t]);
      }
      await q.query('INSERT INTO incident_report_events (report_id, t, kind, detail, actor) VALUES ($1,$2,$3,$4::jsonb,$5)', [id, t, 'reported', JSON.stringify({ kind: input.kind, classification, assets: input.assetIds ?? [] }), subject.username]);
    });
    return (await this.get(id, subject)).report;
  }

  /** Links an asset to a report, while the report is still open. The asset must be visible to the person. */
  async link(id: string, assetId: string, subject: Actor): Promise<ReportView> {
    const r = await this.row(id);
    if (!r || !access(subject, resourceOf(r), 'view').allowed) throw new ReportError('unknown incident report', 404);
    if (!access(subject, resourceOf(r), 'change').allowed) throw new ReportError('only the reporting organisation can change this report', 403);
    if (r.state === 'resolved' || r.state === 'reviewed') throw new ReportError(`a ${r.state} report cannot be linked to new equipment`, 409);
    const t = this.now();
    await this.db.transaction(async (q) => {
      await this.assertVisibleAssets([assetId], subject, q);
      await q.query('INSERT INTO incident_report_assets (report_id, asset_id, linked_by, linked_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, assetId, subject.username, t]);
      await q.query('INSERT INTO incident_report_events (report_id, t, kind, detail, actor) VALUES ($1,$2,$3,$4::jsonb,$5)', [id, t, 'asset_linked', JSON.stringify({ assetId }), subject.username]);
    });
    return (await this.get(id, subject)).report;
  }

  /**
   * Moves a report to the next state. The lifecycle and the rules about who may act (see stepRefusal) are checked here;
   * the route checks the permission for the step. Each move is recorded in the same transaction.
   */
  async transition(
    id: string,
    to: ReportState,
    note: string | null,
    subject: Actor,
    review?: { summary: string; lessons: string | null },
  ): Promise<ReportView> {
    const r = await this.row(id);
    if (!r || !access(subject, resourceOf(r), 'view').allowed) throw new ReportError('unknown incident report', 404);
    if (!access(subject, resourceOf(r), 'change').allowed) throw new ReportError('only the reporting organisation can change this report', 403);
    const level = escalationFor((await this.linkedAssets(id)).map((a) => a.criticality));
    const refusal = stepRefusal({ from: r.state, to, level, actor: subject.username, reportedBy: r.reported_by, resolvedBy: r.resolved_by });
    if (refusal) throw new ReportError(REFUSAL_TEXT[refusal], refusal === 'reporter-cannot-verify' || refusal === 'resolver-cannot-review' ? 403 : 409);
    const t = this.now();
    await this.db.transaction(async (q) => {
      if (to === 'verified') await q.query('UPDATE incident_reports SET state = $2, verified_by = $3, verified_at = $4 WHERE id = $1', [id, to, subject.username, t]);
      else if (to === 'resolved') await q.query('UPDATE incident_reports SET state = $2, resolved_by = $3, resolved_at = $4, resolution = $5 WHERE id = $1', [id, to, subject.username, t, note]);
      else if (to === 'reviewed') await q.query('UPDATE incident_reports SET state = $2, reviewed_by = $3, reviewed_at = $4, review_summary = $5, lessons = $6 WHERE id = $1', [id, to, subject.username, t, review?.summary ?? null, review?.lessons ?? null]);
      else await q.query('UPDATE incident_reports SET state = $2 WHERE id = $1', [id, to]);
      await q.query('INSERT INTO incident_report_events (report_id, t, kind, detail, actor) VALUES ($1,$2,$3,$4::jsonb,$5)', [id, t, `state:${to}`, JSON.stringify({ from: r.state, to, level, note }), subject.username]);
    });
    return (await this.get(id, subject)).report;
  }
}
