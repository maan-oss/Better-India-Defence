import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, patch, post } from '../api/client';
import { STATE_HELP_PRODUCT, STATE_LABEL, uploadEvidence, useVisionLive, type Box, type EvidenceItem, type EvidenceProduct, type FaceEvent, type VisionStatus } from '../api/vision';
import { useSession } from '../state/session';
import { useData } from '../state/data';
import { bytes, dateTime } from '../lib/format';
import { ErrorNote, Loading, Modal, useAsync } from '../components/common';
import { MediaViewer, type Overlay } from '../components/forensics/MediaViewer';
import { ProductView, Workbench } from '../components/forensics/Workbench';
import { FaceCard } from '../components/identity/FaceCard';
import { Icon } from '../components/Icons';
import '../styles/forensics.css';

/**
 * MEDIA FORENSICS — evidence library and imaging workbench.
 * Imagery and video from any source (phones, body cams, drone SD cards, CCTV exports, camera captures) are
 * ingested with a SHA-256, analysed for people / vehicles / faces, and enhanced into hashed products that
 * always reference their source. Originals are immutable.
 */
export function Forensics() {
  const { id } = useParams();
  const nav = useNavigate();
  const can = useSession((s) => s.can);
  const version = useVisionLive((s) => s.evidenceVersion);
  const liveStatus = useVisionLive((s) => s.evidenceStatus);
  const [q, setQ] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const items = useAsync((s) => get<EvidenceItem[]>(`/api/evidence/items${q ? `?q=${encodeURIComponent(q)}` : ''}`, s), [q, version]);
  const status = useAsync((s) => get<VisionStatus>('/api/vision/status', s), []);
  const missing = status.data?.models.filter((m) => !m.installed) ?? [];

  return (
    <div className="page">
      <div className="page-h">
        <h1>Media Forensics</h1>
        <span className="sub">Ingest, analyse and enhance imagery with a complete processing record. Originals are never altered.</span>
        <div className="spacer" />
        {status.data && (
          <span className="row muted" title={status.data.models.map((m) => `${m.name}: ${m.installed ? 'installed' : 'MISSING'}`).join('\n')}>
            <span className={`status-dot ${missing.length ? 'degraded' : 'ok'}`} />
            {missing.length ? `${missing.length} model(s) missing` : 'Vision models ready'} · {status.data.ffmpeg ? 'video ready' : 'no ffmpeg (images only)'}
          </span>
        )}
        {can('evidence.upload') && (
          <button className="btn primary" onClick={() => setShowUpload(true)}>
            <Icon.Upload /> Add evidence
          </button>
        )}
      </div>
      {missing.length > 0 && (
        <div className="note warn" style={{ margin: '10px 20px 0' }}>
          Missing models: {missing.map((m) => m.name).join(', ')}. Run <span className="mono">npm run models:fetch</span> on a connected machine and copy the <span className="mono">models</span> folder. Features
          that need them are disabled; everything else works.
        </div>
      )}
      <div className="page-body fx-body">
        <div className="fx-list">
          <div className="fx-search">
            <input className="input" placeholder="Search title, file name, notes, SHA-256…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="scroll">
            {items.loading && !items.data && <Loading />}
            {items.error && <ErrorNote error={items.error} />}
            {items.data?.length === 0 && <div className="empty">No evidence yet. Add images or video to begin.</div>}
            {items.data?.map((it) => (
              <ItemRow key={it.id} it={it} sel={it.id === id} live={liveStatus[it.id]} onClick={() => nav(`/forensics/${it.id}`)} />
            ))}
          </div>
        </div>
        <div className="fx-work">{id ? <Workspace key={id} id={id} version={version} /> : <EmptyWorkspace />}</div>
      </div>
      {showUpload && (
        <UploadDialog
          onClose={() => setShowUpload(false)}
          onDone={(it) => {
            setShowUpload(false);
            items.reload();
            nav(`/forensics/${it.id}`);
          }}
        />
      )}
    </div>
  );
}

function ItemRow({ it, sel, live, onClick }: { it: EvidenceItem; sel: boolean; live?: string; onClick: () => void }) {
  const a = it.analysis;
  const st = live && live.startsWith('running') ? live : it.analysisStatus;
  return (
    <div className={`fx-item ${sel ? 'sel' : ''}`} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <img src={`/api/evidence/items/${it.id}/frame?w=160${it.kind === 'video' ? '&t=0' : ''}`} alt="" loading="lazy" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">
          <b>{it.title}</b>
        </div>
        <div className="mono dim ellipsis" style={{ fontSize: 11 }}>
          {it.kind === 'video' ? `video ${(it.durationS ?? 0).toFixed(0)} s` : 'image'} · {bytes(it.bytes)} · {it.sha256.slice(0, 10)}…
        </div>
        <div className="row" style={{ gap: 6, fontSize: 11.5 }}>
          <span className={`astat ${st.split(' ')[0]}`}>{st}</span>
          {a.maxPersonsInFrame !== undefined && <span className="muted">{a.maxPersonsInFrame} ppl</span>}
          {a.faceAppearances !== undefined && <span className="muted">{a.faceAppearances} faces</span>}
          {(a.watchlistCandidates ?? 0) > 0 && <span className="wl-flag">{a.watchlistCandidates} watchlist</span>}
        </div>
      </div>
      <span className={`cls ${it.classification}`}>{it.classification.slice(0, 1)}</span>
    </div>
  );
}

function EmptyWorkspace() {
  return (
    <div className="empty" style={{ paddingTop: 80 }}>
      <div style={{ maxWidth: 560, margin: '0 auto', textAlign: 'left' }} className="col">
        <b>How this works</b>
        <span className="muted">1. Add images or video (phone, body camera, drone card, CCTV export). The file is hashed (SHA-256) and stored unmodified.</span>
        <span className="muted">2. Automatic analysis finds people, vehicles and faces; faces are compared with the authorised register and watchlist.</span>
        <span className="muted">3. Enhance a frame or a region: low light, haze/smoke, noise, blur. Each result is a new product with its own hash and a full record of what was done.</span>
        <span className="muted">4. For video, multi-frame fusion combines several real frames of a small region — the only enhancement that adds genuine detail.</span>
        <span className="muted">5. Export the original, the products and the custody report for inquiry or legal use.</span>
      </div>
    </div>
  );
}

type Tab = 'VIEW' | 'ENHANCE' | 'FACES' | 'PRODUCTS' | 'CUSTODY';

function Workspace({ id, version }: { id: string; version: number }) {
  const [params, setParams] = useSearchParams();
  const can = useSession((s) => s.can);
  const item = useAsync((s) => get<EvidenceItem>(`/api/evidence/items/${id}`, s), [id, version]);
  const [tab, setTab] = useState<Tab>('VIEW');
  const [t, setTRaw] = useState(() => Number(params.get('t') ?? 0) || 0);
  const [roi, setRoi] = useState<Box | null>(null);
  const [roiMode, setRoiMode] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>({ persons: true, vehicles: true, faces: true, other: false });
  const [productsV, setProductsV] = useState(0);
  const setT = useCallback(
    (v: number) => {
      setTRaw(v);
      setParams((p) => {
        p.set('t', v.toFixed(3));
        return p;
      }, { replace: true });
    },
    [setParams],
  );
  const it = item.data;
  if (item.error) return <ErrorNote error={item.error} />;
  if (!it) return <Loading />;
  const a = it.analysis;
  return (
    <div className="ws">
      <div className="ws-h">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row">
            <span className={`cls ${it.classification}`}>{it.classification}</span>
            <h2 className="ellipsis">{it.title}</h2>
          </div>
          <div className="mono dim ellipsis" style={{ fontSize: 11 }} title="SHA-256 of the original as received">
            {it.id} · SHA-256 {it.sha256}
          </div>
        </div>
        <div className="seg">
          {(['VIEW', 'ENHANCE', 'FACES', 'PRODUCTS', 'CUSTODY'] as Tab[]).map((k) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="ws-meta">
        <span>
          <b>Captured</b> {it.capturedAt ? dateTime(it.capturedAt) : 'unknown'}
          {it.capturedAtBasis ? <span className="dim"> ({it.capturedAtBasis})</span> : null}
        </span>
        <span>
          <b>Received</b> {dateTime(it.uploadedAt)} by {it.uploadedBy}
        </span>
        <span>
          <b>Source</b> {it.source}
          {it.originalName ? ` · ${it.originalName}` : ''}
        </span>
        <span>
          <b>Analysis</b> <span className={`astat ${it.analysisStatus}`}>{it.analysisStatus}</span>
          {it.analysisStatus === 'complete' && a.framesAnalysed ? <span className="dim"> {a.framesAnalysed} frame(s){a.ms ? ` in ${(a.ms / 1000).toFixed(1)} s` : ''}</span> : null}
          {it.analysisError ? <span className="err-inline"> {it.analysisError}</span> : null}
          {can('evidence.upload') && it.analysisStatus !== 'running' && (
            <button className="btn small ghost" onClick={() => void post(`/api/evidence/items/${id}/analyze`, { mode: 'thorough' }).then(item.reload)} title="Re-run with tiling (small/distant objects) and denser frame sampling">
              Thorough re-analysis
            </button>
          )}
        </span>
      </div>
      {tab === 'VIEW' && (
        <div className="ws-view">
          <div className="ws-tools row">
            {(['persons', 'vehicles', 'faces', 'other'] as (keyof Overlay)[]).map((k) => (
              <label key={k} className="check">
                <input type="checkbox" checked={overlay[k]} onChange={(e) => setOverlay({ ...overlay, [k]: e.target.checked })} />
                {k}
              </label>
            ))}
            <div className="spacer" />
            <button className={`btn small ${roiMode ? 'on' : ''}`} onClick={() => setRoiMode((m) => !m)} title="Drag on the image to select a region">
              {roiMode ? 'Drawing region…' : 'Select region'}
            </button>
            {it.kind === 'video' && can('evidence.enhance') && (
              <button className="btn small" onClick={() => void post<EvidenceProduct>(`/api/evidence/items/${id}/capture`, { t }).then(() => setProductsV((v) => v + 1))}>
                Capture frame (lossless)
              </button>
            )}
            <button className="btn small" onClick={() => setTab('ENHANCE')} disabled={!can('evidence.enhance')}>
              Enhance{roi ? ' region' : ' frame'} →
            </button>
          </div>
          <MediaViewer item={it} t={t} onT={setT} roi={roi} onRoi={(r) => (setRoi(r), setRoiMode(false))} roiMode={roiMode} overlay={overlay} />
          {it.kind === 'video' && <MultiFrame item={it} t={t} roi={roi} onProduct={() => setProductsV((v) => v + 1)} onNeedRoi={() => setRoiMode(true)} />}
          <AnalysisSummaryView it={it} />
        </div>
      )}
      {tab === 'ENHANCE' && (
        <div className="ws-enh">
          <div className="ws-enh-l">
            <MediaViewer item={it} t={t} onT={setT} roi={roi} onRoi={(r) => (setRoi(r), setRoiMode(false))} roiMode={roiMode} overlay={{ persons: false, vehicles: false, faces: false, other: false }} />
            <div className="row" style={{ padding: '6px 0' }}>
              <button className={`btn small ${roiMode ? 'on' : ''}`} onClick={() => setRoiMode((m) => !m)}>
                {roiMode ? 'Drawing region…' : roi ? 'Redraw region' : 'Select region'}
              </button>
              <span className="muted">Work on a region for detail; regions ≤ 512×512 px allow AI upscaling.</span>
            </div>
          </div>
          <div className="ws-enh-r scroll">
            <Workbench item={it} t={t} roi={roi} onProduct={() => setProductsV((v) => v + 1)} />
          </div>
        </div>
      )}
      {tab === 'FACES' && <ItemFaces id={id} />}
      {tab === 'PRODUCTS' && <Products item={it} version={productsV} />}
      {tab === 'CUSTODY' && <Custody id={id} item={it} onSaved={item.reload} />}
    </div>
  );
}

function AnalysisSummaryView({ it }: { it: EvidenceItem }) {
  const a = it.analysis;
  if (it.analysisStatus !== 'complete' || !a.objectCounts) return null;
  const counts = Object.entries(a.objectCounts).sort((x, y) => y[1] - x[1]);
  return (
    <div className="ws-sum">
      <div className="stat-row">
        <div>
          <div className="v">{a.maxPersonsInFrame}</div>
          <div className="l">{it.kind === 'video' ? 'max people in a frame' : 'people'}</div>
        </div>
        <div>
          <div className="v">{a.maxVehiclesInFrame}</div>
          <div className="l">{it.kind === 'video' ? 'max vehicles in a frame' : 'vehicles'}</div>
        </div>
        <div>
          <div className="v">{a.faceAppearances}</div>
          <div className="l">comparable faces</div>
        </div>
        <div>
          <div className={`v ${(a.watchlistCandidates ?? 0) > 0 ? 'amber' : ''}`}>{a.watchlistCandidates}</div>
          <div className="l">watchlist candidates</div>
        </div>
        <div>
          <div className="v">{a.authorisedMatches}</div>
          <div className="l">authorised persons recognised</div>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Detected classes: {counts.map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'} · mode {a.mode}
        {a.sampleFps ? ` · ${a.sampleFps} frames/s sampled` : ''}. Detector: YOLOX-S (COCO). Small or distant objects may be missed in standard mode; use thorough re-analysis.
      </div>
      {a.stats && (
        <div className="mono dim" style={{ fontSize: 11 }}>
          noise σ {a.stats.noiseSigma} · sharpness {a.stats.sharpness} · mean luma {a.stats.meanLuma} · contrast {a.stats.contrast}
        </div>
      )}
    </div>
  );
}

function MultiFrame({ item, t, roi, onProduct, onNeedRoi }: { item: EvidenceItem; t: number; roi: Box | null; onProduct: () => void; onNeedRoi: () => void }) {
  const can = useSession((s) => s.can);
  const [frames, setFrames] = useState(12);
  const [scale, setScale] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<EvidenceProduct | null>(null);
  const ok = roi && roi.w <= 200 && roi.h <= 200 && roi.w >= 8 && roi.h >= 8;
  if (!can('evidence.enhance')) return null;
  return (
    <div className="mf">
      <div className="row">
        <b>Multi-frame fusion</b>
        <span className="muted">Registers {frames} consecutive real frames around {t.toFixed(2)} s and fuses them — genuine extra detail where the subject is static and the camera moves slightly.</span>
      </div>
      <div className="row">
        <label className="row muted">
          Frames
          <input className="input" type="number" min={3} max={32} value={frames} onChange={(e) => setFrames(Number(e.target.value))} style={{ width: 64 }} />
        </label>
        <label className="row muted">
          Scale ×
          <select className="input" value={scale} onChange={(e) => setScale(Number(e.target.value))}>
            {[2, 3, 4].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        {!ok ? (
          <button className="btn small" onClick={onNeedRoi}>
            Select a region ≤ 200×200 px
          </button>
        ) : (
          <button
            className="btn small primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setErr(null);
              post<EvidenceProduct>(`/api/evidence/items/${item.id}/multiframe`, { t, roi, frames, scale })
                .then((p) => {
                  setRes(p);
                  onProduct();
                })
                .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Fusing…' : 'Fuse frames'}
          </button>
        )}
      </div>
      {err && <ErrorNote error={err} />}
      {res && (
        <div className="col">
          <span className="muted">
            Used {res.usedFrames} of {frames} frames ({res.rejectedFrames} rejected: motion or occlusion too different to register).
          </span>
          <ProductView product={res} item={item} />
        </div>
      )}
    </div>
  );
}

function ItemFaces({ id }: { id: string }) {
  const fv = useVisionLive((s) => s.faceVersion);
  const faces = useAsync((s) => get<FaceEvent[]>(`/api/faces?source=${id}&limit=500`, s), [id, fv]);
  const can = useSession((s) => s.can);
  if (!can('identity.view')) return <div className="empty">Your role cannot view recognition results.</div>;
  if (faces.error) return <ErrorNote error={faces.error} />;
  if (!faces.data) return <Loading />;
  const order = { STRONG: 0, POSSIBLE: 1, NO_MATCH: 2, NOT_COMPARABLE: 3 };
  const sorted = [...faces.data].sort((a, b) => order[a.decision] - order[b.decision] || (a.tMedia ?? 0) - (b.tMedia ?? 0));
  return (
    <div className="scroll" style={{ padding: 14 }}>
      <div className="note" style={{ marginBottom: 12 }}>
        Faces are compared with the authorised register and the watchlist. A match is a candidate for human verification, not an identification. Faces too small, blurred or turned
        away are recorded as not comparable rather than guessed.
      </div>
      {!sorted.length && <div className="empty">No comparable faces were found in this item.</div>}
      <div className="fgrid">
        {sorted.map((ev) => (
          <FaceCard key={ev.id} ev={ev} onChanged={faces.reload} />
        ))}
      </div>
    </div>
  );
}

function Products({ item, version }: { item: EvidenceItem; version: number }) {
  const prods = useAsync((s) => get<EvidenceProduct[]>(`/api/evidence/items/${item.id}/products`, s), [item.id, version]);
  const [open, setOpen] = useState<EvidenceProduct | null>(null);
  if (!prods.data) return <Loading />;
  return (
    <div className="scroll" style={{ padding: 14 }}>
      {!prods.data.length && <div className="empty">No products yet. Use VIEW (capture / multi-frame) or ENHANCE.</div>}
      <div className="pgrid">
        {prods.data.map((p) => (
          <div key={p.id} className="pcard" onClick={() => setOpen(p)} role="button" tabIndex={0}>
            <img src={`/api/evidence/products/${p.id}/image`} alt={p.state} loading="lazy" />
            <div className="row">
              <span className={`pstate small ${p.state}`} title={STATE_HELP_PRODUCT[p.state]}>
                {p.state}
              </span>
              <span className="muted">{p.kind.replace('_', ' ')}</span>
              <div className="spacer" />
              <span className="mono dim">{p.frameT !== null ? `${p.frameT.toFixed(2)} s` : ''}</span>
            </div>
            <div className="mono dim ellipsis" style={{ fontSize: 10.5 }}>
              {p.sha256Out.slice(0, 24)}… · {p.createdBy}
            </div>
          </div>
        ))}
      </div>
      {open && (
        <Modal title={`${open.id} — ${STATE_LABEL[open.state]}`} onClose={() => setOpen(null)} wide>
          <ProductView product={open} item={item} />
        </Modal>
      )}
    </div>
  );
}

interface CustodyReport {
  item: EvidenceItem;
  products: EvidenceProduct[];
  custody: { t: number; actor: string; role: string; action: string; detail: Record<string, unknown> }[];
  faces: number;
}

function Custody({ id, item, onSaved }: { id: string; item: EvidenceItem; onSaved: () => void }) {
  const rep = useAsync((s) => get<CustodyReport>(`/api/evidence/items/${id}/report`, s), [id]);
  const can = useSession((s) => s.can);
  const incidents = useData((s) => s.incidents);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ title: item.title, notes: item.notes ?? '', incidentId: item.incidentId ?? '', capturedAt: item.capturedAt ? new Date(item.capturedAt).toISOString().slice(0, 19) : '', capturedAtBasis: item.capturedAtBasis ?? '', classification: item.classification });
  if (!rep.data) return <Loading />;
  const r = rep.data;
  return (
    <div className="scroll custody" style={{ padding: 18 }}>
      <div className="row no-print">
        <button className="btn small" onClick={() => window.print()}>
          Print / save as PDF
        </button>
        {can('evidence.export') && (
          <a className="btn small" href={`/api/evidence/items/${id}/original`}>
            Export original (hash-verified)
          </a>
        )}
        {can('evidence.upload') && (
          <button className="btn small" onClick={() => setEdit((e) => !e)}>
            Edit metadata
          </button>
        )}
      </div>
      {edit && (
        <div className="panel no-print" style={{ padding: 12, margin: '10px 0' }}>
          <div className="formgrid">
            <label>Title</label>
            <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <label>Captured (UTC)</label>
            <input className="input" type="datetime-local" step={1} value={form.capturedAt} onChange={(e) => setForm({ ...form, capturedAt: e.target.value })} />
            <label>Basis for capture time</label>
            <input className="input" value={form.capturedAtBasis} placeholder="e.g. camera clock verified against GPS at 14:05" onChange={(e) => setForm({ ...form, capturedAtBasis: e.target.value })} />
            <label>Incident</label>
            <select className="input" value={form.incidentId} onChange={(e) => setForm({ ...form, incidentId: e.target.value })}>
              <option value="">— none —</option>
              {incidents.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.code} {i.title}
                </option>
              ))}
            </select>
            <label>Classification</label>
            <select className="input" value={form.classification} onChange={(e) => setForm({ ...form, classification: e.target.value })}>
              {['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <label>Notes</label>
            <textarea className="input" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <button
            className="btn primary small"
            onClick={() =>
              void patch(`/api/evidence/items/${id}`, {
                title: form.title,
                notes: form.notes || null,
                incidentId: form.incidentId || null,
                capturedAt: form.capturedAt ? Date.parse(`${form.capturedAt}Z`) : null,
                capturedAtBasis: form.capturedAtBasis || null,
                classification: form.classification,
              }).then(() => {
                setEdit(false);
                onSaved();
                rep.reload();
              })
            }
          >
            Save (audited)
          </button>
        </div>
      )}
      <div className="print-banner">{r.item.classification}</div>
      <h2>Evidence record {r.item.id}</h2>
      <dl className="kv">
        <dt>Title</dt>
        <dd>{r.item.title}</dd>
        <dt>Type</dt>
        <dd>
          {r.item.kind}
          {r.item.kind === 'video' ? ` · ${(r.item.durationS ?? 0).toFixed(2)} s · ${(r.item.fps ?? 0).toFixed(2)} fps` : ''} · {r.item.width}×{r.item.height}
        </dd>
        <dt>Original file</dt>
        <dd className="mono">
          {r.item.originalName ?? '—'} · {r.item.bytes} bytes
        </dd>
        <dt>SHA-256 (original)</dt>
        <dd className="mono">{r.item.sha256}</dd>
        <dt>Captured</dt>
        <dd>
          {r.item.capturedAt ? dateTime(r.item.capturedAt) : 'unknown'} {r.item.capturedAtBasis ? `— ${r.item.capturedAtBasis}` : ''}
        </dd>
        <dt>Received</dt>
        <dd>
          {dateTime(r.item.uploadedAt)} by {r.item.uploadedBy} (source: {r.item.source})
        </dd>
        <dt>Incident</dt>
        <dd>{r.item.incidentId ?? '—'}</dd>
        <dt>Faces recorded</dt>
        <dd>{r.faces}</dd>
        <dt>Notes</dt>
        <dd>{r.item.notes ?? '—'}</dd>
      </dl>
      <h3>Derived products ({r.products.length})</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Product</th>
            <th>State</th>
            <th>Processing</th>
            <th>SHA-256 out</th>
            <th>By / when</th>
          </tr>
        </thead>
        <tbody>
          {r.products.map((p) => (
            <tr key={p.id}>
              <td className="mono">
                {p.id}
                <br />
                <span className="dim">
                  {p.kind}
                  {p.frameT !== null ? ` @ ${p.frameT.toFixed(3)} s` : ''}
                </span>
              </td>
              <td>
                <span className={`pstate small ${p.state}`}>{p.state}</span>
              </td>
              <td style={{ fontSize: 11.5 }}>{p.steps.map((s) => (typeof s.op === 'string' ? s.op : s.op.op)).join(' → ')}</td>
              <td className="mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>
                {p.sha256Out}
              </td>
              <td style={{ fontSize: 11.5 }}>
                {p.createdBy}
                <br />
                {dateTime(p.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Custody and access trail ({r.custody.length})</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Time (UTC)</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {r.custody.map((c, i) => (
            <tr key={i}>
              <td className="mono">{dateTime(c.t)}</td>
              <td>
                {c.actor} <span className="dim">({c.role})</span>
              </td>
              <td>{c.action.replace(/_/g, ' ')}</td>
              <td className="mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>
                {JSON.stringify(c.detail)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 11.5 }}>
        Trail entries are taken from the append-only, hash-chained audit log (verify under Audit). Product hashes allow any copy to be checked against this record.
      </p>
    </div>
  );
}

function UploadDialog({ onClose, onDone }: { onClose: () => void; onDone: (it: EvidenceItem) => void }) {
  const incidents = useData((s) => s.incidents);
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState('');
  const [classification, setClassification] = useState('RESTRICTED');
  const [capturedAt, setCapturedAt] = useState('');
  const [basis, setBasis] = useState('');
  const [incidentId, setIncidentId] = useState('');
  const [notes, setNotes] = useState('');
  const [mode, setMode] = useState<'standard' | 'thorough'>('standard');
  const [progress, setProgress] = useState<{ i: number; f: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const total = useMemo(() => files.reduce((a, f) => a + f.size, 0), [files]);

  const go = async () => {
    setErr(null);
    let last: EvidenceItem | null = null;
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      setProgress({ i, f: 0 });
      try {
        const r = await uploadEvidence(
          f,
          {
            title: files.length === 1 && title ? title : title ? `${title} (${i + 1}/${files.length})` : f.name,
            classification,
            ...(capturedAt ? { capturedAt: String(Date.parse(`${capturedAt}Z`)), capturedAtBasis: basis || 'entered by operator' } : {}),
            ...(incidentId ? { incidentId } : {}),
            ...(notes ? { notes } : {}),
            mode,
          },
          (p) => setProgress({ i, f: p }),
        );
        last = r.item;
      } catch (e) {
        setErr(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
        setProgress(null);
        return;
      }
    }
    if (last) onDone(last);
  };

  return (
    <Modal title="Add evidence" onClose={onClose}>
      <div
        className={`drop ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          setFiles([...e.dataTransfer.files]);
        }}
        onClick={() => input.current?.click()}
      >
        <Icon.Upload />
        <div>{files.length ? `${files.length} file(s) · ${bytes(total)}` : 'Drop images or video here, or click to choose'}</div>
        <div className="dim" style={{ fontSize: 11.5 }}>
          JPEG, PNG, WebP, TIFF, MP4, MOV, MKV, AVI… up to 2 GB each. Files are hashed on receipt and stored unmodified{' '}
        </div>
        <input ref={input} type="file" multiple accept="image/*,video/*,.mkv,.avi,.ts,.dav" style={{ display: 'none' }} onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      </div>
      <div className="formgrid" style={{ marginTop: 12 }}>
        <label>Title</label>
        <input className="input" value={title} placeholder={files[0]?.name ?? 'e.g. Gate 2 CCTV export, night of 3 Oct'} onChange={(e) => setTitle(e.target.value)} />
        <label>Classification</label>
        <select className="input" value={classification} onChange={(e) => setClassification(e.target.value)}>
          {['UNCLASSIFIED', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <label>Captured (UTC)</label>
        <input className="input" type="datetime-local" step={1} value={capturedAt} onChange={(e) => setCapturedAt(e.target.value)} />
        <label>Time basis</label>
        <input className="input" value={basis} placeholder="How is the capture time known? (camera clock checked, witness, …)" onChange={(e) => setBasis(e.target.value)} />
        <label>Incident</label>
        <select className="input" value={incidentId} onChange={(e) => setIncidentId(e.target.value)}>
          <option value="">— none —</option>
          {incidents.map((i) => (
            <option key={i.id} value={i.id}>
              {i.code} {i.title}
            </option>
          ))}
        </select>
        <label>Analysis</label>
        <div className="seg">
          <button className={mode === 'standard' ? 'on' : ''} onClick={() => setMode('standard')}>
            STANDARD
          </button>
          <button className={mode === 'thorough' ? 'on' : ''} onClick={() => setMode('thorough')}>
            THOROUGH
          </button>
        </div>
        <label>Notes</label>
        <textarea className="input" rows={2} value={notes} placeholder="Where it came from, who handed it over, seal numbers…" onChange={(e) => setNotes(e.target.value)} />
      </div>
      {progress && (
        <div className="prog">
          <div style={{ width: `${((progress.i + progress.f) / files.length) * 100}%` }} />
          <span>
            Uploading {progress.i + 1}/{files.length} · {Math.round(progress.f * 100)}%
          </span>
        </div>
      )}
      {err && <ErrorNote error={err} />}
      <div className="row" style={{ marginTop: 12 }}>
        <div className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!files.length || Boolean(progress)} onClick={() => void go()}>
          Ingest {files.length > 1 ? `${files.length} files` : ''}
        </button>
      </div>
    </Modal>
  );
}
