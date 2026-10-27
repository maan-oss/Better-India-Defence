import type { Subject } from '@strata/domain';
import type { Db } from '../db/client.ts';
import { loadRef, type RecordKind } from './records.ts';

export interface RecordComment {
  id: number;
  recordKind: RecordKind;
  recordId: string;
  author: string;
  body: string;
  createdAt: number;
}

interface CommentRow {
  id: string;
  record_kind: RecordKind;
  record_id: string;
  author: string;
  body: string;
  created_at: string;
}

const toComment = (r: CommentRow): RecordComment => ({
  id: Number(r.id),
  recordKind: r.record_kind,
  recordId: r.record_id,
  author: r.author,
  body: r.body,
  createdAt: Number(r.created_at),
});

/**
 * The discussion on a record. Whoever can see a record can read its thread and add to it; a record they cannot see
 * has no thread for them. Comments are append-only, so the thread is a record of what was said and when.
 */
export class RecordCommentService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async list(kind: RecordKind, id: string, subject: Subject): Promise<RecordComment[]> {
    await loadRef(this.db, kind, id, subject);
    const rows = (await this.db.query<CommentRow>('SELECT id, record_kind, record_id, author, body, created_at FROM record_comments WHERE record_kind = $1 AND record_id = $2 ORDER BY id', [kind, id])).rows;
    return rows.map(toComment);
  }

  async add(kind: RecordKind, id: string, body: string, subject: Subject & { username: string }): Promise<RecordComment> {
    await loadRef(this.db, kind, id, subject);
    const row = (
      await this.db.query<CommentRow>(
        'INSERT INTO record_comments (record_kind, record_id, author, body, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, record_kind, record_id, author, body, created_at',
        [kind, id, subject.username, body, this.now()],
      )
    ).rows[0]!;
    return toComment(row);
  }
}
