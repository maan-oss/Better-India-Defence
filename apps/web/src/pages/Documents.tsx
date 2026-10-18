import { Fragment, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post, patch } from '../api/client';
import { ErrorNote, Loading, useAsync } from '../components/common';
import { Button } from '../components/arc/button/button';
import { Input } from '../components/arc/input/input';
import { SearchField } from '../components/arc/search-field/search-field';
import { Textarea } from '../components/arc/textarea/textarea';
import { dateTime, titleCase } from '../lib/format';
import { useSession } from '../state/session';

type Kind = 'text' | 'markdown' | 'csv';
type Confidence = 'unreviewed' | 'probable' | 'confirmed' | 'disputed';

interface DocumentHit {
  id: string;
  title: string;
  source: string;
  kind: Kind;
  rows: number | null;
  classification: string;
  owner: string;
  documentDate: number | null;
  uploadedBy: string;
  uploadedAt: number;
  confidence: Confidence;
  confidenceBy: string | null;
  excerpt: string;
}
interface DocumentDetail extends DocumentHit {
  body: string;
  confidenceNote: string | null;
}

const KINDS: Kind[] = ['text', 'markdown', 'csv'];
const CONFIDENCE: Confidence[] = ['unreviewed', 'probable', 'confirmed', 'disputed'];
const CONFIDENCE_LABEL: Record<Confidence, string> = { unreviewed: 'Not yet assessed', probable: 'Probably accurate', confirmed: 'Confirmed', disputed: 'Disputed' };
const CONFIDENCE_TONE: Record<Confidence, string> = { unreviewed: 'info', probable: 'amber', confirmed: 'ok', disputed: 'red' };
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The search excerpt: matched words are marked as text, never as markup, so a document cannot inject anything. */
function Excerpt({ text }: { text: string }) {
  const parts = text.split(/(\[\[.*?\]\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('[[') && p.endsWith(']]') ? (
          <mark key={i} style={{ background: 'var(--amber-soft, #fde68a)', color: 'inherit', borderRadius: 3, padding: '0 2px' }}>
            {p.slice(2, -2)}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** Document library: search across the documents the person may see, the documents themselves, and loading new ones. */
export function Documents() {
  const { id } = useParams();
  const nav = useNavigate();
  const can = useSession((s) => s.can);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const hits = useAsync((s) => get<DocumentHit[]>(`/api/documents/search?q=${encodeURIComponent(query)}`, s), [query, version]);
  const changed = () => setVersion((v) => v + 1);
  return (
    <div className="page" data-view={id ? 'detail' : 'list'}>
      <div className="page-h">
        <h1>Documents</h1>
        <span className="sub">Loaded text, with where it came from, who loaded it, and what an analyst has assessed.</span>
        <div className="spacer" />
        {can('documents.upload') && (
          <Button variant="secondary" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Close' : 'Add document'}
          </Button>
        )}
      </div>
      <div className="page-body split">
        <div className="scroll as-list-pane">
          <div style={{ padding: 12 }}>
            <SearchField
              label="Search documents"
              placeholder="Words to find"
              value={filter}
              onValueChange={setFilter}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Enter') setQuery(filter.trim());
              }}
            />
            <div style={{ marginTop: 8 }}>
              <Button size="sm" variant="secondary" onClick={() => setQuery(filter.trim())}>
                Search
              </Button>
            </div>
          </div>
          {adding && (
            <AddDocument
              onDone={(d) => {
                setAdding(false);
                changed();
                nav(`/documents/${d.id}`);
              }}
            />
          )}
          {hits.error && <ErrorNote error={hits.error} />}
          {!hits.data && !hits.error && <Loading />}
          {hits.data && hits.data.length === 0 && <p className="muted">{query ? 'Nothing you can see matches those words.' : 'No documents you can see yet.'}</p>}
          {(hits.data ?? []).length > 0 && (
            <ul className="as-list" aria-label="Documents">
              {(hits.data ?? []).map((d) => (
                <li key={d.id} style={{ padding: '8px 0' }}>
                  <button type="button" className="as-row" style={{ gridTemplateColumns: 'minmax(0, 1fr)', alignItems: 'start', textAlign: 'left', width: '100%', whiteSpace: 'normal' }} aria-current={d.id === id ? 'true' : undefined} onClick={() => nav(`/documents/${d.id}`)}>
                    <b>{d.title}</b>
                    <span className="muted" style={{ fontSize: 'var(--fs-caption)' }}>
                      {d.source} · {d.uploadedBy} · {dateTime(d.uploadedAt)}
                    </span>
                    {d.excerpt && <span style={{ fontSize: 'var(--fs-body)' }}>{<Excerpt text={d.excerpt} />}</span>}
                    <span className={`chip ${CONFIDENCE_TONE[d.confidence]}`} style={{ justifySelf: 'start' }}>
                      {CONFIDENCE_LABEL[d.confidence]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="scroll as-detail-pane">
          {id ? <DocumentPane id={id} onChanged={changed} version={version} /> : <p className="muted">Choose a document to read it and see its assessment.</p>}
        </div>
      </div>
    </div>
  );
}

function AddDocument({ onDone }: { onDone: (d: DocumentDetail) => void }) {
  const clearance = useSession((s) => s.user?.clearance) ?? 'UNCLASSIFIED';
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('');
  const [kind, setKind] = useState<Kind>('text');
  const [text, setText] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const classes = ['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET'];
  const [classification, setClassification] = useState('UNCLASSIFIED');
  const allowed = classes.slice(0, classes.indexOf(clearance) + 1);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const documentDate = date ? Date.parse(date) : null;
      onDone(await post<DocumentDetail>('/api/documents', { title: title.trim(), source: source.trim(), kind, text, classification, documentDate }));
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="as-form" onSubmit={submit} aria-label="Add a document" style={{ margin: '0 12px' }}>
      <Input label="Title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <Input label="Where it came from" value={source} maxLength={200} onChange={(e) => setSource(e.target.value)} />
      <label className="as-field">
        <span>Kind</span>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {titleCase(k)}
            </option>
          ))}
        </select>
      </label>
      <label className="as-field">
        <span>Classification</span>
        <select className="input" value={classification} onChange={(e) => setClassification(e.target.value)}>
          {allowed.map((c) => (
            <option key={c} value={c}>
              {titleCase(c)}
            </option>
          ))}
        </select>
      </label>
      <Input label="Date of the source (optional)" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <Textarea label="Text" value={text} maxLength={1000000} onChange={(e) => setText(e.target.value)} />
      <div className="as-actions">
        <Button type="submit" disabled={busy || title.trim().length < 1 || source.trim().length < 1 || text.trim().length < 1}>
          Load document
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

function DocumentPane({ id, onChanged, version }: { id: string; onChanged: () => void; version: number }) {
  const can = useSession((s) => s.can);
  const me = useSession((s) => s.user?.username);
  const [local, setLocal] = useState(0);
  const doc = useAsync((s) => get<DocumentDetail>(`/api/documents/${id}`, s), [id, version, local]);
  const [level, setLevel] = useState<Confidence>('confirmed');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (doc.error) return <ErrorNote error={doc.error} />;
  if (!doc.data) return <Loading />;
  const d = doc.data;
  const assess = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await patch(`/api/documents/${d.id}/confidence`, { confidence: level, note: note.trim() || undefined });
      setNote('');
      setLocal((n) => n + 1);
      onChanged();
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article aria-label={`Document ${d.title}`}>
      <h2 style={{ margin: '4px 0' }}>{d.title}</h2>
      <p className="note">
        From {d.source} · loaded by {d.uploadedBy}, {dateTime(d.uploadedAt)}
        {d.documentDate ? ` · source dated ${dateTime(d.documentDate)}` : ''} · {titleCase(d.kind)}
        {d.rows !== null ? ` · ${d.rows} rows` : ''} · {titleCase(d.classification)}
      </p>
      <p>
        <span className={`chip ${CONFIDENCE_TONE[d.confidence]}`}>{CONFIDENCE_LABEL[d.confidence]}</span>
        {d.confidenceBy ? ` · assessed by ${d.confidenceBy}` : ''}
      </p>
      {d.confidenceNote && <p className="note">{d.confidenceNote}</p>}
      <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-body)', background: 'var(--bg-2, #f5f5f5)', padding: 12, borderRadius: 8 }}>
        {d.body}
      </pre>
      {can('documents.review') && me !== d.uploadedBy && (
        <form className="as-form" onSubmit={assess} aria-label="Assess the content">
          <h3>Assess the content</h3>
          <label className="as-field">
            <span>Confidence</span>
            <select className="input" value={level} onChange={(e) => setLevel(e.target.value as Confidence)}>
              {CONFIDENCE.filter((c) => c !== 'unreviewed').map((c) => (
                <option key={c} value={c}>
                  {CONFIDENCE_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <Input label="Why (kept with the assessment)" value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} />
          <div className="as-actions">
            <Button type="submit" disabled={busy}>
              Record assessment
            </Button>
          </div>
        </form>
      )}
      {can('documents.review') && me === d.uploadedBy && <p className="note">You loaded this document, so someone else must assess it.</p>}
      {err && (
        <p className="as-error" role="alert">
          {err}
        </p>
      )}
    </article>
  );
}
