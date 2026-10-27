import { access, type Classification, type Subject } from '@strata/domain';
import type { Db } from '../db/client.ts';

export const RECORD_KINDS = ['incident_report', 'asset'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** A refusal the caller can show: the HTTP status and a sentence an operator can act on. */
export class RecordError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A record as the visibility rule needs it: its identity, its classification, and who may see it. */
export interface RecordRef {
  kind: RecordKind;
  id: string;
  /** The short code a person reads first: the report code or the asset tag. */
  label: string;
  title: string;
  classification: Classification;
  owner: string;
  sharedWith: string[];
}

export const visibleTo = (r: RecordRef, subject: Subject): boolean =>
  access(subject, { classification: r.classification, owner: r.owner, sharedWith: r.sharedWith }, 'view').allowed;

const UNKNOWN: Record<RecordKind, string> = { incident_report: 'unknown incident report', asset: 'unknown asset' };

/** Refs for the ids given, in no particular order. Ids that do not exist are simply absent. */
export async function fetchRefs(db: Db, kind: RecordKind, ids: string[]): Promise<RecordRef[]> {
  if (ids.length === 0) return [];
  if (kind === 'incident_report') {
    const rows = (await db.query<{ id: string; code: string; title: string; classification: Classification; owner: string }>('SELECT id, code, title, classification, owner FROM incident_reports WHERE id = ANY($1)', [ids])).rows;
    // A report is shared with no organisation: only its owner, and people cleared for it, can see it.
    return rows.map((r) => ({ kind, id: r.id, label: r.code, title: r.title, classification: r.classification, owner: r.owner, sharedWith: [] }));
  }
  const rows = (await db.query<{ id: string; tag: string; name: string; classification: Classification; owner: string; shared_with: string[] }>('SELECT id, tag, name, classification, owner, shared_with FROM assets WHERE id = ANY($1)', [ids])).rows;
  return rows.map((a) => ({ kind, id: a.id, label: a.tag, title: a.name, classification: a.classification, owner: a.owner, sharedWith: a.shared_with }));
}

/** One record the person may see. A record they may not see is unknown, the same refusal whichever way it is asked for. */
export async function loadRef(db: Db, kind: RecordKind, id: string, subject: Subject): Promise<RecordRef> {
  const [r] = await fetchRefs(db, kind, [id]);
  if (!r || !visibleTo(r, subject)) throw new RecordError(UNKNOWN[kind], 404);
  return r;
}
