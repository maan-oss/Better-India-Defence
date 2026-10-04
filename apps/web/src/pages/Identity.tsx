import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FACILITY } from '@strata/domain';
import { get, patch, post, put } from '../api/client';
import { analysePhoto, useVisionLive, type FaceEvent, type FaceSettings, type Identity as IdentityT, type PhotoFaces, type Template, type VisionStatus } from '../api/vision';
import { useSession } from '../state/session';
import { dateTime } from '../lib/format';
import { ErrorNote, Loading, useAsync } from '../components/common';
import { DECISION_TEXT, DecisionChip, FaceCard, QualityLine } from '../components/identity/FaceCard';
import '../styles/forensics.css';

/**
 * IDENTITY — authorised-personnel register, watchlist, recognition review and archive search.
 * The system proposes candidates; people decide. Every registry change, review and search is audited.
 */
type Tab = 'REVIEW' | 'SIGHTINGS' | 'REGISTER' | 'SEARCH' | 'SETTINGS';

export function Identity() {
  const [params, setParams] = useSearchParams();
  const can = useSession((s) => s.can);
  const pending = useVisionLive((s) => s.pendingReview);
  const tab = ((params.get('tab')?.toUpperCase() as Tab | undefined) ?? (can('face.review') ? 'REVIEW' : 'SIGHTINGS')) as Tab;
  const setTab = (t: Tab) => setParams({ tab: t });
  const tabs: Tab[] = ['REVIEW', 'SIGHTINGS', 'REGISTER', 'SEARCH', 'SETTINGS'];
  return (
    <div className="page">
      <div className="page-h">
        <h1>Identity</h1>
        <span className="sub">Recognition proposes candidates; trained personnel decide. Results are not identifications until confirmed.</span>
        <div className="spacer" />
        <div className="seg">
          {tabs.map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t}
              {t === 'REVIEW' && pending > 0 ? ` (${pending})` : ''}
            </button>
          ))}
        </div>
      </div>
      <div className="page-body id-body">
        {tab === 'REVIEW' && <Review faceId={params.get('face')} />}
        {tab === 'SIGHTINGS' && <Sightings />}
        {tab === 'REGISTER' && <Register selected={params.get('id')} onSelect={(id) => setParams({ tab: 'REGISTER', id })} />}
        {tab === 'SEARCH' && <Search faceId={params.get('face')} identityId={params.get('identity')} />}
        {tab === 'SETTINGS' && <Settings />}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------------------

function Review({ faceId }: { faceId: string | null }) {
  const fv = useVisionLive((s) => s.faceVersion);
  const refresh = useVisionLive((s) => s.refreshCounts);
  const list = useAsync((s) => get<FaceEvent[]>('/api/faces?review=PENDING&limit=200', s), [fv]);
  const [sel, setSel] = useState<string | null>(faceId);
  useEffect(() => {
    if (!sel && list.data?.length) setSel(list.data[0]!.id);
  }, [list.data, sel]);
  return (
    <div className="rv">
      <div className="rv-list">
        <div className="panel-h">
          <h3>Awaiting verification</h3>
          <div className="spacer" />
          <span className="muted">{list.data?.length ?? '…'}</span>
        </div>
        <div className="scroll">
          {list.data?.length === 0 && <div className="empty">Nothing to review.</div>}
          {list.data?.map((ev) => (
            <div key={ev.id} className={`list-row ${sel === ev.id ? 'sel' : ''}`} onClick={() => setSel(ev.id)}>
              <img src={`/api/faces/${ev.id}/image?which=aligned`} alt="" style={{ width: 40, height: 40 }} />
              <div className="grow" style={{ minWidth: 0 }}>
                <DecisionChip ev={ev} />
                <div className="ellipsis">
                  {ev.candidates[0]?.name ?? '—'} <span className="mono muted">{ev.bestScore?.toFixed(2)}</span>
                </div>
                <div className="mono dim" style={{ fontSize: 10.5 }}>
                  {ev.sourceId} · {dateTime(ev.t)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="rv-detail">
        {sel ? (
          <ReviewDetail
            id={sel}
            onDone={() => {
              setSel(null);
              list.reload();
              void refresh();
            }}
          />
        ) : (
          <div className="empty">Select a sighting.</div>
        )}
      </div>
    </div>
  );
}

function ReviewDetail({ id, onDone }: { id: string; onDone: () => void }) {
  const can = useSession((s) => s.can);
  const ev = useAsync((s) => get<FaceEvent>(`/api/faces/${id}`, s), [id]);
  const st = useAsync((s) => get<FaceSettings>('/api/faces/settings', s), []);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!ev.data || !st.data) return <Loading />;
  const e = ev.data;
  const decide = async (decision: 'CONFIRMED' | 'REJECTED') => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/faces/${id}/review`, { decision, note });
      onDone();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 14, maxWidth: 1100 }}>
      <div className="row">
        <DecisionChip ev={e} />
        <span className="mono muted">{e.id}</span>
        <div className="spacer" />
        {e.alertId && <span className="muted">alert {e.alertId}</span>}
      </div>
      <div className="cmp-faces">
        <figure>
          <img src={`/api/faces/${e.id}/image`} alt="Sighting (context)" />
          <figcaption>
            <b>Sighting</b> — as captured
            <br />
            <QualityLine q={e.quality} />
            {e.quality.reasons.length > 0 && <div className="muted" style={{ fontSize: 11 }}>{e.quality.reasons.join('; ')}</div>}
          </figcaption>
        </figure>
        <figure>
          <img src={`/api/faces/${e.id}/image?which=aligned`} alt="Sighting (aligned)" style={{ imageRendering: 'pixelated' }} />
          <figcaption>Aligned crop used for comparison (112×112)</figcaption>
        </figure>
        {e.candidates.map((c) => (
          <figure key={c.identityId}>
            <img src={`/api/identities/templates/${c.templateId}/image`} alt={`Enrolled photo of ${c.name}`} />
            <figcaption>
              <span className={`lchip ${c.list}`}>{c.list}</span> <b>{c.name}</b>
              <ScoreBar score={c.score} strong={st.data!.strong} possible={st.data!.possible} />
              <Link to={`/identity?tab=REGISTER&id=${c.identityId}`} className="muted" style={{ fontSize: 11 }}>
                open register entry
              </Link>
            </figcaption>
          </figure>
        ))}
      </div>
      <dl className="kv">
        <dt>Source</dt>
        <dd>
          {e.sourceKind === 'evidence' ? <Link to={`/forensics/${e.sourceId}${e.tMedia !== null ? `?t=${e.tMedia}` : ''}`}>{e.sourceId}</Link> : e.sourceId}
          {e.tMedia !== null ? ` @ ${e.tMedia.toFixed(2)} s` : ''}
        </dd>
        <dt>Time</dt>
        <dd className="mono">{dateTime(e.t)}</dd>
        <dt>Decision rule</dt>
        <dd>
          Strong ≥ {st.data.strong.toFixed(2)}, possible ≥ {st.data.possible.toFixed(2)} (cosine similarity, SFace). A POOR-quality face can never be a strong match. {DECISION_TEXT[e.decision]}.
        </dd>
      </dl>
      <div className="note warn">
        Verify against independent information before acting: compare distinctive features (ears, scars, hairline), clothing and context, and the plausibility of this person being at this place
        and time. Similar-looking people exist; the score is a measure of resemblance, not proof.
      </div>
      {can('face.review') ? (
        <div className="col">
          <textarea className="input" rows={3} placeholder="Basis for your decision (required, recorded in the audit trail)" value={note} onChange={(x) => setNote(x.target.value)} />
          <div className="row">
            <button className="btn primary" disabled={busy || note.trim().length < 3} onClick={() => void decide('CONFIRMED')}>
              Confirm identity
            </button>
            <button className="btn danger" disabled={busy || note.trim().length < 3} onClick={() => void decide('REJECTED')}>
              Reject — not this person
            </button>
          </div>
          {err && <ErrorNote error={err} />}
        </div>
      ) : (
        <div className="muted">Your role cannot record a review decision.</div>
      )}
    </div>
  );
}

function ScoreBar({ score, strong, possible }: { score: number; strong: number; possible: number }) {
  return (
    <div className="col" style={{ gap: 2, margin: '4px 0' }}>
      <div className="score-bar" title={`score ${score.toFixed(3)}; possible ≥ ${possible}, strong ≥ ${strong}`}>
        <i style={{ width: `${Math.max(0, Math.min(1, score)) * 100}%` }} />
        <b style={{ left: `${possible * 100}%`, opacity: 0.5 }} />
        <b style={{ left: `${strong * 100}%` }} />
      </div>
      <span className="mono" style={{ fontSize: 11 }}>
        {score.toFixed(3)}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------------------

function Sightings() {
  const fv = useVisionLive((s) => s.faceVersion);
  const [decision, setDecision] = useState<string>('');
  const list = useAsync((s) => get<FaceEvent[]>(`/api/faces?limit=300${decision ? `&decision=${decision}` : ''}`, s), [fv, decision]);
  return (
    <div className="scroll" style={{ padding: 16 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted">Filter</span>
        <div className="seg">
          {['', 'STRONG', 'POSSIBLE', 'NO_MATCH', 'NOT_COMPARABLE'].map((d) => (
            <button key={d} className={decision === d ? 'on' : ''} onClick={() => setDecision(d)}>
              {d ? d.replace('_', ' ') : 'ALL'}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <span className="muted">Unmatched sightings are deleted automatically after the retention period (Settings).</span>
      </div>
      {list.error && <ErrorNote error={list.error} />}
      {!list.data && <Loading />}
      {list.data?.length === 0 && <div className="empty">No face sightings recorded.</div>}
      <div className="fgrid">
        {list.data?.map((ev) => (
          <FaceCard key={ev.id} ev={ev} onChanged={list.reload} />
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------------------

const ZONES = FACILITY.zones;

function Register({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const can = useSession((s) => s.can);
  const [list, setList] = useState<'AUTHORISED' | 'WATCHLIST'>('AUTHORISED');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const ids = useAsync((s) => get<IdentityT[]>(`/api/identities?list=${list}${q ? `&q=${encodeURIComponent(q)}` : ''}`, s), [list, q]);
  return (
    <div className="reg">
      <div className="reg-list">
        <div className="row" style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
          <div className="seg">
            <button className={list === 'AUTHORISED' ? 'on' : ''} onClick={() => setList('AUTHORISED')}>
              AUTHORISED
            </button>
            <button className={list === 'WATCHLIST' ? 'on' : ''} onClick={() => setList('WATCHLIST')}>
              WATCHLIST
            </button>
          </div>
          <div className="spacer" />
          {can('identity.enrol') && (list === 'AUTHORISED' || can('identity.watchlist')) && (
            <button className="btn small primary" onClick={() => setCreating(true)}>
              + New
            </button>
          )}
        </div>
        <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
          <input className="input" style={{ width: '100%' }} placeholder="Name, service number, unit…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="scroll">
          {ids.data?.length === 0 && <div className="empty">No entries.</div>}
          {ids.data?.map((i) => (
            <div key={i.id} className={`list-row ${selected === i.id ? 'sel' : ''}`} onClick={() => (setCreating(false), onSelect(i.id))}>
              {i.photoTemplateId ? <img src={`/api/identities/templates/${i.photoTemplateId}/image?which=aligned`} alt="" style={{ width: 36, height: 36 }} /> : <div style={{ width: 36, height: 36, border: '1px dashed var(--line-3)' }} />}
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis">
                  {i.rank ? `${i.rank} ` : ''}
                  <b>{i.name}</b>
                </div>
                <div className="mono dim ellipsis" style={{ fontSize: 10.5 }}>
                  {[i.serviceNo, i.unit ?? i.organisation, i.category].filter(Boolean).join(' · ')}
                </div>
              </div>
              {i.status !== 'ACTIVE' && <span className="chip">{i.status}</span>}
              {i.threatLevel && <span className={`lchip ${i.list}`}>{i.threatLevel}</span>}
              <span className="mono muted" title="enrolled photos">
                {i.templates}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="reg-detail">
        {creating ? (
          <IdentityForm
            list={list}
            onSaved={(i) => {
              setCreating(false);
              ids.reload();
              onSelect(i.id);
            }}
          />
        ) : selected ? (
          <IdentityDetail id={selected} onChanged={ids.reload} />
        ) : (
          <div className="empty">
            Select an entry, or create one. Authorised-register entries record who may be where; watchlist entries require a documented basis and analyst rights.
          </div>
        )}
      </div>
    </div>
  );
}

function IdentityForm({ list, initial, onSaved }: { list: 'AUTHORISED' | 'WATCHLIST'; initial?: IdentityT; onSaved: (i: IdentityT) => void }) {
  const [f, setF] = useState({
    category: initial?.category ?? (list === 'WATCHLIST' ? 'Person of interest' : 'Personnel'),
    name: initial?.name ?? '',
    rank: initial?.rank ?? '',
    serviceNo: initial?.serviceNo ?? '',
    unit: initial?.unit ?? '',
    organisation: initial?.organisation ?? '',
    accessZones: initial?.accessZones ?? [],
    threatLevel: initial?.threatLevel ?? 'MEDIUM',
    basis: initial?.basis ?? '',
    notes: initial?.notes ?? '',
    validUntil: initial?.validUntil ? new Date(initial.validUntil).toISOString().slice(0, 10) : '',
  });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    const body = {
      category: f.category,
      name: f.name,
      rank: f.rank || null,
      serviceNo: f.serviceNo || null,
      unit: f.unit || null,
      organisation: f.organisation || null,
      accessZones: f.accessZones,
      threatLevel: list === 'WATCHLIST' ? f.threatLevel : null,
      basis: f.basis || null,
      notes: f.notes || null,
      validUntil: f.validUntil ? Date.parse(`${f.validUntil}T23:59:59Z`) : null,
    };
    try {
      onSaved(initial ? await patch<IdentityT>(`/api/identities/${initial.id}`, body) : await post<IdentityT>('/api/identities', { ...body, list }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const cats = list === 'WATCHLIST' ? ['Person of interest', 'Banned from site', 'Missing person', 'Absconder'] : ['Personnel', 'Contractor', 'Visitor', 'Family', 'Vendor', 'Other'];
  return (
    <div className="col" style={{ maxWidth: 720, gap: 12 }}>
      <h3 style={{ margin: 0 }}>{initial ? 'Edit entry' : list === 'WATCHLIST' ? 'New watchlist entry' : 'New authorised person'}</h3>
      <div className="formgrid">
        <label>Category</label>
        <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {cats.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <label>Full name</label>
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <label>Rank</label>
        <input className="input" value={f.rank} placeholder="e.g. Maj, Sub, Hav, Nk, Sep" onChange={(e) => setF({ ...f, rank: e.target.value })} />
        <label>Service / ID number</label>
        <input className="input" value={f.serviceNo} onChange={(e) => setF({ ...f, serviceNo: e.target.value })} />
        <label>Unit</label>
        <input className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
        <label>Organisation</label>
        <input className="input" value={f.organisation} onChange={(e) => setF({ ...f, organisation: e.target.value })} />
        {list === 'AUTHORISED' && (
          <>
            <label>Restricted-zone access</label>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {ZONES.filter((z) => z.restricted).map((z) => (
                <label key={z.id} className="check">
                  <input type="checkbox" checked={f.accessZones.includes(z.id)} onChange={(e) => setF({ ...f, accessZones: e.target.checked ? [...f.accessZones, z.id] : f.accessZones.filter((x) => x !== z.id) })} />
                  {z.name}
                </label>
              ))}
            </div>
            <label>Valid until</label>
            <input className="input" type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} />
          </>
        )}
        {list === 'WATCHLIST' && (
          <>
            <label>Threat level</label>
            <select className="input" value={f.threatLevel} onChange={(e) => setF({ ...f, threatLevel: e.target.value as 'LOW' | 'MEDIUM' | 'HIGH' })}>
              {['LOW', 'MEDIUM', 'HIGH'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <label>Basis (required)</label>
            <textarea className="input" rows={3} value={f.basis} placeholder="Authority and source: order / intelligence report reference, who requested the listing, review date." onChange={(e) => setF({ ...f, basis: e.target.value })} />
          </>
        )}
        <label>Notes</label>
        <textarea className="input" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </div>
      {err && <ErrorNote error={err} />}
      <div className="row">
        <button className="btn primary" disabled={f.name.trim().length < 2} onClick={() => void save()}>
          Save (audited)
        </button>
      </div>
    </div>
  );
}

function IdentityDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const can = useSession((s) => s.can);
  const d = useAsync((s) => get<Omit<IdentityT, 'templates'> & { templates: Template[] }>(`/api/identities/${id}`, s), [id]);
  const sightings = useAsync((s) => get<FaceEvent[]>(`/api/faces?identity=${id}&limit=60`, s), [id]);
  const [editing, setEditing] = useState(false);
  if (d.error) return <ErrorNote error={d.error} />;
  if (!d.data) return <Loading />;
  const i = d.data;
  const mayEdit = can('identity.enrol') && (i.list === 'AUTHORISED' || can('identity.watchlist'));
  if (editing)
    return (
      <IdentityForm
        list={i.list}
        initial={{ ...i, templates: i.templates.length }}
        onSaved={() => {
          setEditing(false);
          d.reload();
          onChanged();
        }}
      />
    );
  return (
    <div className="col" style={{ gap: 14, maxWidth: 1000 }}>
      <div className="row">
        <span className={`lchip ${i.list}`}>{i.list}</span>
        <h3 style={{ margin: 0 }}>
          {i.rank ? `${i.rank} ` : ''}
          {i.name}
        </h3>
        <span className="chip">{i.status}</span>
        <div className="spacer" />
        {mayEdit && (
          <>
            <button className="btn small" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              className="btn small"
              onClick={() => void patch(`/api/identities/${i.id}`, { status: i.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' }).then(() => (d.reload(), onChanged()))}
              title="Suspended entries are not matched"
            >
              {i.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
            </button>
          </>
        )}
        {can('face.search') && (
          <Link className="btn small" to={`/identity?tab=SEARCH&identity=${i.id}`}>
            Search archive
          </Link>
        )}
      </div>
      <dl className="kv">
        <dt>Category</dt>
        <dd>{i.category}</dd>
        <dt>Service / ID no.</dt>
        <dd className="mono">{i.serviceNo ?? '—'}</dd>
        <dt>Unit / organisation</dt>
        <dd>{[i.unit, i.organisation].filter(Boolean).join(' · ') || '—'}</dd>
        {i.list === 'AUTHORISED' && (
          <>
            <dt>Zone access</dt>
            <dd>{i.accessZones.length ? i.accessZones.map((z) => ZONES.find((x) => x.id === z)?.name ?? z).join(', ') : 'No restricted zones'}</dd>
            <dt>Valid until</dt>
            <dd>{i.validUntil ? dateTime(i.validUntil) : 'no expiry'}</dd>
          </>
        )}
        {i.list === 'WATCHLIST' && (
          <>
            <dt>Threat level</dt>
            <dd>{i.threatLevel}</dd>
            <dt>Basis</dt>
            <dd>{i.basis ?? <span className="muted">restricted to analysts</span>}</dd>
          </>
        )}
        <dt>Notes</dt>
        <dd>{i.notes ?? '—'}</dd>
        <dt>Created</dt>
        <dd>
          {dateTime(i.createdAt)} by {i.createdBy}
        </dd>
      </dl>
      <div>
        <h4 className="upper muted">Enrolled photos ({i.templates.length})</h4>
        <div className="tpl-grid">
          {i.templates.map((t) => (
            <figure key={t.id}>
              <img src={`/api/identities/templates/${t.id}/image?which=aligned`} alt="Enrolled face" />
              <span className={`qline ${t.quality.grade}`}>{t.quality.grade}</span>
              <span className="dim">{t.source.split(':')[0]}</span>
              {mayEdit && (
                <button className="btn small ghost" onClick={() => void fetch(`/api/identities/templates/${t.id}`, { method: 'DELETE', credentials: 'same-origin' }).then(() => (d.reload(), onChanged()))}>
                  Remove
                </button>
              )}
            </figure>
          ))}
          {!i.templates.length && <span className="muted">No photos — this entry cannot be recognised until a photo is enrolled.</span>}
        </div>
      </div>
      {mayEdit && (
        <EnrolPhoto
          identityId={i.id}
          onDone={() => {
            d.reload();
            onChanged();
          }}
        />
      )}
      <div>
        <h4 className="upper muted">Recent sightings</h4>
        {sightings.data?.length === 0 && <span className="muted">None recorded.</span>}
        <div className="fgrid">
          {sightings.data?.map((ev) => (
            <FaceCard key={ev.id} ev={ev} compact />
          ))}
        </div>
      </div>
    </div>
  );
}

function PhotoPicker({ onAnalysed }: { onAnalysed: (r: PhotoFaces, url: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="col">
      <label className="btn small" style={{ alignSelf: 'flex-start' }}>
        {busy ? 'Analysing…' : 'Choose photo…'}
        <input
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setBusy(true);
            setErr(null);
            analysePhoto(f)
              .then((r) => onAnalysed(r, URL.createObjectURL(f)))
              .catch((x: unknown) => setErr(x instanceof Error ? x.message : String(x)))
              .finally(() => setBusy(false));
          }}
        />
      </label>
      {err && <ErrorNote error={err} />}
    </div>
  );
}

function EnrolPhoto({ identityId, onDone }: { identityId: string; onDone: () => void }) {
  const [r, setR] = useState<PhotoFaces | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const enrol = async (index: number) => {
    setErr(null);
    try {
      const res = await post<{ id: string; duplicateOf: { name: string; score: number } | null }>(`/api/identities/${identityId}/templates`, { token: r!.token, faceIndex: index });
      setMsg(res.duplicateOf ? `Enrolled. Warning: this face also strongly matches ${res.duplicateOf.name} (${res.duplicateOf.score.toFixed(2)}) — possible duplicate entry.` : 'Enrolled.');
      setR(null);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="panel" style={{ padding: 12 }}>
      <h4 className="upper muted" style={{ margin: '0 0 8px' }}>
        Enrol photo
      </h4>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Use a recent, frontal, well-lit photo (ID-card or gate-pass quality). Several photos (different days, with/without spectacles) improve recognition. Faces below FAIR quality are
        refused.
      </div>
      <PhotoPicker onAnalysed={(x) => (setR(x), setMsg(null))} />
      {r && (
        <div className="chooser" style={{ marginTop: 10 }}>
          {r.faces.length === 0 && <span className="muted">No face found in that photo.</span>}
          {r.faces.map((f) => (
            <button key={f.index} disabled={!f.usable || f.quality.grade === 'POOR'} onClick={() => void enrol(f.index)} title={f.quality.reasons.join('; ')}>
              <img src={`data:image/jpeg;base64,${f.crop}`} alt={`Face ${f.index + 1}`} />
              <QualityLine q={f.quality} />
              {f.matches[0] && f.matches[0].score > 0.32 && <span className="muted" style={{ fontSize: 11 }}>resembles {f.matches[0].name} ({f.matches[0].score.toFixed(2)})</span>}
            </button>
          ))}
        </div>
      )}
      {err && <ErrorNote error={err} />}
      {msg && <div className="note" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------------------

function Search({ faceId, identityId }: { faceId: string | null; identityId: string | null }) {
  const can = useSession((s) => s.can);
  const [probe, setProbe] = useState<{ kind: 'face'; id: string } | { kind: 'identity'; id: string } | { kind: 'photo'; token: string; index: number; url: string } | null>(
    faceId ? { kind: 'face', id: faceId } : identityId ? { kind: 'identity', id: identityId } : null,
  );
  const [photo, setPhoto] = useState<{ r: PhotoFaces; url: string } | null>(null);
  const [purpose, setPurpose] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [minScore, setMinScore] = useState<number | null>(null);
  const [res, setRes] = useState<{ minScore: number; strong: number; results: FaceEvent[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ident = useAsync((s) => (probe?.kind === 'identity' ? get<IdentityT>(`/api/identities/${probe.id}`, s) : Promise.resolve(null)), [probe]);
  if (!can('face.search')) return <div className="empty">Archive search requires analyst rights.</div>;
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        purpose,
        ...(probe?.kind === 'face' ? { faceEventId: probe.id } : probe?.kind === 'identity' ? { identityId: probe.id } : probe?.kind === 'photo' ? { token: probe.token, faceIndex: probe.index } : {}),
        ...(from ? { from: Date.parse(`${from}Z`) } : {}),
        ...(to ? { to: Date.parse(`${to}Z`) } : {}),
        ...(minScore ? { minScore } : {}),
      };
      setRes(await post('/api/faces/search', body));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scroll" style={{ padding: 16 }}>
      <div className="col" style={{ maxWidth: 900, gap: 12 }}>
        <div className="note">
          Searches every stored face sighting (cameras and evidence) for faces resembling the probe. Each search is recorded with its purpose. Results above the strong threshold are
          strong candidates; below it, resemblance only.
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
          <div className="col" style={{ width: 170 }}>
            <b className="upper muted">Probe</b>
            {probe?.kind === 'face' && <img src={`/api/faces/${probe.id}/image`} alt="Probe face" style={{ width: 160, height: 160, objectFit: 'cover' }} />}
            {probe?.kind === 'identity' && (
              <div>
                {ident.data?.photoTemplateId && <img src={`/api/identities/templates/${ident.data.photoTemplateId}/image`} alt="" style={{ width: 160, height: 160, objectFit: 'cover' }} />}
                <div>{ident.data?.name ?? probe.id}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  all enrolled photos
                </div>
              </div>
            )}
            {probe?.kind === 'photo' && <img src={probe.url} alt="Probe" style={{ width: 160 }} />}
            {!probe && <span className="muted">Upload a photo, or start from a sighting or register entry.</span>}
            <PhotoPicker onAnalysed={(r, url) => setPhoto({ r, url })} />
          </div>
          <div className="col grow">
            {photo && (
              <div className="chooser">
                {photo.r.faces.map((f) => (
                  <button key={f.index} disabled={!f.usable} onClick={() => (setProbe({ kind: 'photo', token: photo.r.token, index: f.index, url: `data:image/jpeg;base64,${f.crop}` }), setPhoto(null))}>
                    <img src={`data:image/jpeg;base64,${f.crop}`} alt="" />
                    <QualityLine q={f.quality} />
                  </button>
                ))}
              </div>
            )}
            <div className="formgrid">
              <label>Purpose (required)</label>
              <input className="input" value={purpose} placeholder="e.g. Trace movements of subject in INC-2026-004 investigation" onChange={(e) => setPurpose(e.target.value)} />
              <label>From (UTC)</label>
              <input className="input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
              <label>To (UTC)</label>
              <input className="input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
              <label>Minimum score</label>
              <input className="input" type="number" step={0.01} min={0.1} max={0.95} placeholder="default: possible threshold" value={minScore ?? ''} onChange={(e) => setMinScore(e.target.value ? Number(e.target.value) : null)} />
            </div>
            <div className="row">
              <button className="btn primary" disabled={!probe || purpose.trim().length < 5 || busy} onClick={() => void run()}>
                {busy ? 'Searching…' : 'Search archive'}
              </button>
            </div>
            {err && <ErrorNote error={err} />}
          </div>
        </div>
        {res && (
          <div className="col">
            <span className="muted">
              {res.results.length} sighting(s) ≥ {res.minScore.toFixed(2)} · strong ≥ {res.strong.toFixed(2)}
            </span>
            <div className="fgrid">
              {res.results.map((ev) => (
                <div key={ev.id} className="col" style={{ gap: 2 }}>
                  <span className="mono" style={{ fontSize: 11, color: (ev.score ?? 0) >= res.strong ? 'var(--text-0)' : 'var(--text-2)' }}>
                    similarity {ev.score?.toFixed(3)} {(ev.score ?? 0) >= res.strong ? '· strong' : '· resemblance'}
                  </span>
                  <FaceCard ev={ev} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------------------

function Settings() {
  const can = useSession((s) => s.can);
  const st = useAsync((s) => get<VisionStatus>('/api/vision/status', s), []);
  const [f, setF] = useState<FaceSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (st.data && !f) setF(st.data.settings);
  }, [st.data, f]);
  if (!st.data || !f) return <Loading />;
  const save = () =>
    put<FaceSettings>('/api/faces/settings', f)
      .then(() => setMsg('Saved (audited).'))
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)));
  return (
    <div className="scroll" style={{ padding: 16 }}>
      <div className="col" style={{ maxWidth: 900, gap: 16 }}>
        <div className="cards" style={{ border: '1px solid var(--line)' }}>
          <div className="stat">
            <div className="v">{st.data.gallery.authorised}</div>
            <div className="l">authorised entries</div>
          </div>
          <div className="stat">
            <div className="v">{st.data.gallery.watchlist}</div>
            <div className="l">watchlist entries</div>
          </div>
          <div className="stat">
            <div className="v">{st.data.gallery.templates}</div>
            <div className="l">enrolled photos</div>
          </div>
        </div>
        <div className="panel" style={{ padding: 14 }}>
          <h4 className="upper muted" style={{ margin: '0 0 10px' }}>
            Decision thresholds (cosine similarity)
          </h4>
          <div className="formgrid">
            <label>Strong match ≥</label>
            <input className="input" type="number" step={0.01} value={f.strong} disabled={!can('admin.config')} onChange={(e) => setF({ ...f, strong: Number(e.target.value) })} />
            <label>Possible match ≥</label>
            <input className="input" type="number" step={0.01} value={f.possible} disabled={!can('admin.config')} onChange={(e) => setF({ ...f, possible: Number(e.target.value) })} />
            <label>Minimum face quality</label>
            <select className="input" value={f.minGrade} disabled={!can('admin.config')} onChange={(e) => setF({ ...f, minGrade: e.target.value as FaceSettings['minGrade'] })}>
              {['GOOD', 'FAIR', 'POOR'].map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
            <label>Keep unmatched sightings</label>
            <div className="row">
              <input className="input" type="number" min={1} max={3650} value={f.retentionDays} disabled={!can('admin.config')} onChange={(e) => setF({ ...f, retentionDays: Number(e.target.value) })} style={{ width: 90 }} />
              <span className="muted">days, then deleted (images included)</span>
            </div>
            <label>Unknown faces</label>
            <label className="check">
              <input type="checkbox" checked={f.alertUnknownInRestricted} disabled={!can('admin.config')} onChange={(e) => setF({ ...f, alertUnknownInRestricted: e.target.checked })} />
              Alert when a camera covering a restricted zone sees a face not in the authorised register
            </label>
          </div>
          {can('admin.config') && (
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary small" onClick={() => void save()}>
                Save
              </button>
              {msg && <span className="muted">{msg}</span>}
            </div>
          )}
          <div className="note" style={{ marginTop: 12 }}>
            Defaults come from a measured benchmark (LFW verification pairs, this exact pipeline): best accuracy 98.2% at 0.32; no false accepts among 274 impostor pairs at ≥ 0.32 and 3.7%
            false rejects; at 0.42 false rejects rise to 4.4%. Accuracy on CCTV at distance, at night or through haze is lower and must be measured on your own cameras with{' '}
            <span className="mono">npm run vision:eval</span>. In 1:N search against a register of N people, the chance of some false candidate grows roughly N-fold — which is why every
            watchlist candidate needs human verification.
          </div>
        </div>
        <div className="panel">
          <div className="panel-h">
            <h3>Models</h3>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Purpose</th>
                <th>Licence</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {st.data.models.map((m) => (
                <tr key={m.key}>
                  <td>
                    {m.name}
                    <div className="mono dim" style={{ fontSize: 10 }}>
                      {m.sha256.slice(0, 16)}…
                    </div>
                  </td>
                  <td style={{ fontSize: 12 }}>{m.purpose}</td>
                  <td style={{ fontSize: 12 }}>{m.licence}</td>
                  <td>{m.installed ? (m.verified ? 'verified · loaded' : 'installed') : <span className="err-inline">{m.error}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
