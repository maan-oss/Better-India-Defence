import { Empty } from '../brand/Boot';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../api/client';
import type { AssetView } from '@strata/domain/client';
import { ErrorNote, Loading, useAsync } from '../components/common';
import { Button } from '../components/arc/button/button';
import { Input } from '../components/arc/input/input';
import { Textarea } from '../components/arc/textarea/textarea';
import { dateTime, titleCase } from '../lib/format';
import { useSession } from '../state/session';
import '../styles/assets.css';

type ReportState = 'reported' | 'verified' | 'escalated' | 'responding' | 'resolved' | 'reviewed';
type Level = 'watch' | 'duty' | 'command';

interface ReportRow {
  id: string;
  code: string;
  title: string;
  kind: string;
  description: string;
  state: ReportState;
  classification: string;
  reportedBy: string;
  reportedAt: number;
  verifiedBy: string | null;
  resolvedBy: string | null;
  resolution: string | null;
  reviewedBy: string | null;
  reviewSummary: string | null;
  lessons: string | null;
  level: Level;
  assets: { id: string; tag: string; name: string; criticality: number }[];
  nextSteps: ReportState[];
}
interface ReportEvent {
  id: number;
  t: number;
  kind: string;
  detail: Record<string, unknown>;
  actor: string;
}

const STATE_LABEL: Record<ReportState, string> = { reported: 'Reported', verified: 'Verified', escalated: 'Escalated', responding: 'Responding', resolved: 'Resolved', reviewed: 'Reviewed' };
const STATE_TONE: Record<ReportState, string> = { reported: 'info', verified: 'ok', escalated: 'red', responding: 'amber', resolved: 'ok', reviewed: '' };
const LEVEL_LABEL: Record<Level, string> = { watch: 'Watch', duty: 'Duty', command: 'Command' };
const KINDS = ['intrusion', 'power', 'fire', 'medical', 'access', 'cyber', 'other'] as const;
const CLASSES = ['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET'] as const;
/** The permission each step needs, as the server checks it. */
const STEP_PERMISSION: Record<ReportState, string> = { reported: 'incidents.create', verified: 'reports.verify', escalated: 'incidents.edit', responding: 'incidents.edit', resolved: 'incidents.edit', reviewed: 'reports.review' };
const STEP_VERB: Record<ReportState, string> = { reported: 'Report', verified: 'Verify', escalated: 'Escalate', responding: 'Start response', resolved: 'Resolve', reviewed: 'Review' };
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Incident reports: the list, the report with the steps it may take, its linked equipment and its history. */
export function IncidentReports() {
  const { id } = useParams();
  const nav = useNavigate();
  const can = useSession((s) => s.can);
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const list = useAsync((s) => get<ReportRow[]>('/api/incident-reports', s), [version]);
  const changed = () => setVersion((v) => v + 1);
  return (
    <div className="page" data-view={id ? 'detail' : 'list'}>
      <div className="page-h">
        <h1>Incident reports</h1>
        <span className="sub">Reported, verified, escalated by the criticality of equipment, responded to, resolved and reviewed.</span>
        <div className="spacer" />
        {can('incidents.create') && (
          <Button variant="secondary" onClick={() => setCreating((c) => !c)}>
            {creating ? 'Close' : 'New report'}
          </Button>
        )}
      </div>
      <div className="page-body split">
        <div className="scroll as-list-pane">
          {creating && (
            <NewReport
              onDone={(r) => {
                setCreating(false);
                changed();
                nav(`/reports/${r.id}`);
              }}
            />
          )}
          {list.error && <ErrorNote error={list.error} />}
          {!list.data && !list.error && <Loading />}
          {list.data && list.data.length === 0 && <Empty compact art="evidence" title="No reports you can see" description="Reports you are allowed to see are listed here." />}
          {(list.data ?? []).length > 0 && (
            <ul className="as-list" aria-label="Incident reports">
              {(list.data ?? []).map((r) => (
                <li key={r.id}>
                  <button type="button" className="as-row" aria-current={r.id === id ? 'true' : undefined} onClick={() => nav(`/reports/${r.id}`)}>
                    <span className="mono as-tag">{r.code}</span>
                    <span className="as-name">{r.title}</span>
                    <span className={`chip ${STATE_TONE[r.state]}`}>{STATE_LABEL[r.state]}</span>
                    <span className="mono as-crit" title={`${LEVEL_LABEL[r.level]} level`}>
                      {LEVEL_LABEL[r.level]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="scroll as-detail-pane">
          {id ? <ReportDetail id={id} onChanged={changed} version={version} /> : <Empty art="evidence" title="Choose a report" description="Its steps, equipment and history are shown here." />}
        </div>
      </div>
    </div>
  );
}

function NewReport({ onDone }: { onDone: (r: ReportRow) => void }) {
  const clearance = useSession((s) => s.user?.clearance) ?? 'UNCLASSIFIED';
  const assets = useAsync((s) => get<AssetView[]>('/api/assets', s), []);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('intrusion');
  const [description, setDescription] = useState('');
  const [classification, setClassification] = useState<(typeof CLASSES)[number]>('UNCLASSIFIED');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const allowed = CLASSES.slice(0, CLASSES.indexOf(clearance as (typeof CLASSES)[number]) + 1);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onDone(await post<ReportRow>('/api/incident-reports', { title: title.trim(), kind, description: description.trim(), classification, assetIds: picked }));
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="as-form" onSubmit={submit} aria-label="New incident report" style={{ marginTop: 12 }}>
      <Input label="Title" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
      <label className="as-field">
        <span>Kind</span>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {titleCase(k)}
            </option>
          ))}
        </select>
      </label>
      <label className="as-field">
        <span>Classification</span>
        <select className="input" value={classification} onChange={(e) => setClassification(e.target.value as (typeof CLASSES)[number])}>
          {allowed.map((c) => (
            <option key={c} value={c}>
              {titleCase(c)}
            </option>
          ))}
        </select>
      </label>
      <Textarea label="What was observed" value={description} maxLength={4000} onChange={(e) => setDescription(e.target.value)} />
      <fieldset style={{ border: 0, padding: 0, margin: '8px 0' }}>
        <legend>Equipment affected (optional)</legend>
        {(assets.data ?? []).slice(0, 40).map((a) => (
          <label key={a.id} style={{ display: 'block' }}>
            <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a.id] : p.filter((x) => x !== a.id)))} /> <span className="mono">{a.tag}</span> {a.name} · criticality {a.criticality}
          </label>
        ))}
      </fieldset>
      <div className="as-actions">
        <Button type="submit" disabled={busy || title.trim().length < 3 || description.trim().length < 1}>
          File report
        </Button>
      </div>
      {err && (
        <p className="as-error" role="alert">
          {err}
        </p>
      )}
    </form>
  );
}

function ReportDetail({ id, onChanged, version }: { id: string; onChanged: () => void; version: number }) {
  const can = useSession((s) => s.can);
  const me = useSession((s) => s.user?.username);
  const [local, setLocal] = useState(0);
  const detail = useAsync((s) => get<{ report: ReportRow; events: ReportEvent[] }>(`/api/incident-reports/${id}`, s), [id, version, local]);
  const assets = useAsync((s) => get<AssetView[]>('/api/assets', s), [id, version]);
  const [note, setNote] = useState('');
  const [summary, setSummary] = useState('');
  const [lessons, setLessons] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (detail.error) return <ErrorNote error={detail.error} />;
  if (!detail.data) return <Loading />;
  const { report: r, events } = detail.data;
  const after = () => {
    setLocal((n) => n + 1);
    onChanged();
  };
  const act = async (fn: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      done?.();
      after();
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };
  const steps = r.nextSteps.filter((s) => s !== 'reviewed' && can(STEP_PERMISSION[s]));
  const canReview = r.nextSteps.includes('reviewed') && can('reports.review');
  const linkable = (assets.data ?? []).filter((a) => !r.assets.some((x) => x.id === a.id));
  return (
    <article aria-label={`Report ${r.code}`}>
      <header>
        <span className="mono">{r.code}</span>
        <h2 style={{ margin: '4px 0' }}>{r.title}</h2>
        <span className={`chip ${STATE_TONE[r.state]}`}>{STATE_LABEL[r.state]}</span> <span>{LEVEL_LABEL[r.level]} level</span> · {titleCase(r.kind)} · {titleCase(r.classification)}
      </header>
      <p>{r.description}</p>
      <p className="note">
        Reported by {r.reportedBy}, {dateTime(r.reportedAt)}
        {r.verifiedBy ? ` · verified by ${r.verifiedBy}` : ''}
        {r.resolvedBy ? ` · resolved by ${r.resolvedBy}` : ''}
        {r.reviewedBy ? ` · reviewed by ${r.reviewedBy}` : ''}
      </p>
      <h2 className="sub-h">Equipment</h2>
      {r.assets.length === 0 && <p className="note">None linked. Watch level applies.</p>}
      <ul>
        {r.assets.map((a) => (
          <li key={a.id}>
            <span className="mono">{a.tag}</span> {a.name} · criticality {a.criticality}
          </li>
        ))}
      </ul>
      {r.state !== 'resolved' && r.state !== 'reviewed' && can('incidents.edit') && linkable.length > 0 && (
        <div className="as-form">
          <label className="as-field">
            <span>Link equipment</span>
            <select className="input" value={link} onChange={(e) => setLink(e.target.value)}>
              <option value="">Choose…</option>
              {linkable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.tag} · criticality {a.criticality}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" disabled={busy || !link} onClick={() => void act(() => post(`/api/incident-reports/${r.id}/assets`, { assetId: link }), () => setLink(''))}>
            Link
          </Button>
        </div>
      )}
      <h2 className="sub-h">Next steps</h2>
      {steps.length === 0 && !canReview && <p className="note">Nothing you can do on this report now{me && r.reportedBy === me ? ' — you reported it, so someone else must verify it' : ''}.</p>}
      {steps.length > 0 && (
        <div className="as-form">
          <Input label="Note (kept in the history)" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          <div className="as-actions">
            {steps.map((s) => (
              <Button key={s} disabled={busy} onClick={() => void act(() => post(`/api/incident-reports/${r.id}/transition`, { to: s, note: note.trim() || undefined }), () => setNote(''))}>
                {STEP_VERB[s]}
              </Button>
            ))}
          </div>
        </div>
      )}
      {canReview && (
        <form
          className="as-form"
          aria-label="Post-incident review"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => post(`/api/incident-reports/${r.id}/review`, { summary: summary.trim(), lessons: lessons.trim() || undefined }), () => {
              setSummary('');
              setLessons('');
            });
          }}
        >
          <h2 className="sub-h">Post-incident review</h2>
          <Textarea label="Summary" value={summary} maxLength={4000} onChange={(e) => setSummary(e.target.value)} />
          <Textarea label="Lessons" value={lessons} maxLength={4000} onChange={(e) => setLessons(e.target.value)} />
          <div className="as-actions">
            <Button type="submit" disabled={busy || !summary.trim()}>
              Complete review
            </Button>
          </div>
        </form>
      )}
      {r.reviewSummary && (
        <div className="note">
          <b>Review:</b> {r.reviewSummary}
          {r.lessons ? ` Lessons: ${r.lessons}` : ''}
        </div>
      )}
      {err && (
        <p className="as-error" role="alert">
          {err}
        </p>
      )}
      <h2 className="sub-h">History</h2>
      <ol aria-label="History">
        {events.map((e) => (
          <li key={e.id}>
            {dateTime(e.t)} · <b>{e.kind.replace('state:', '')}</b> · {e.actor}
            {typeof e.detail.note === 'string' && e.detail.note ? ` — ${e.detail.note}` : ''}
          </li>
        ))}
      </ol>
    </article>
  );
}
