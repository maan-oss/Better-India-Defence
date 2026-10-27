import { useState, type FormEvent } from 'react';
import { get, post } from '../api/client';
import { dateTime } from '../lib/format';
import { useSession } from '../state/session';
import { ErrorNote, Loading, useAsync } from './common';
import { Button } from './arc/button/button';
import { Textarea } from './arc/textarea/textarea';
import '../styles/records.css';

export interface RecordComment {
  id: number;
  recordKind: 'incident_report' | 'asset';
  recordId: string;
  author: string;
  body: string;
  createdAt: number;
}

/** The discussion on one record: who said what and when. Anyone who can see the record can read it; those who may comment can add to it. */
export function RecordComments({ kind, id }: { kind: 'incident_report' | 'asset'; id: string }) {
  const can = useSession((s) => s.can);
  const [version, setVersion] = useState(0);
  const thread = useAsync((s) => get<RecordComment[]>(`/api/records/${kind}/${id}/comments`, s), [kind, id, version]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/records/${kind}/${id}/comments`, { body: body.trim() });
      setBody('');
      setVersion((v) => v + 1);
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'The comment was not added.');
    } finally {
      setBusy(false);
    }
  };

  if (thread.error) return <ErrorNote error={thread.error} />;
  if (!thread.data) return <Loading />;
  return (
    <section className="rdisc">
      {thread.data.length === 0 ? (
        <p className="dim">No comments yet.</p>
      ) : (
        <ol className="rdisc-thread" aria-label="Comments">
          {thread.data.map((c) => (
            <li key={c.id}>
              <div className="rdisc-meta mono">
                <b>{c.author}</b> · {dateTime(c.createdAt)}
              </div>
              <p>{c.body}</p>
            </li>
          ))}
        </ol>
      )}
      {can('records.comment') && (
        <form onSubmit={submit} className="rdisc-form">
          <Textarea label="Add a comment" value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} />
          <div className="as-actions">
            <Button type="submit" disabled={busy || !body.trim()}>
              Add comment
            </Button>
          </div>
        </form>
      )}
      {err && (
        <p className="as-error" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}
