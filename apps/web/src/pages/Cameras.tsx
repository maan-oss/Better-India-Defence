import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FACILITY } from '@strata/domain';
import { api, get, post } from '../api/client';
import { useVisionLive, type FaceEvent } from '../api/vision';
import { useSession } from '../state/session';
import { ago, bytes } from '../lib/format';
import { ErrorNote, Loading, Modal, useAsync } from '../components/common';
import { FaceCard } from '../components/identity/FaceCard';
import { CameraFeed } from '../components/CameraFeed';
import { Icon } from '../components/Icons';
import { useData } from '../state/data';
import { useTime } from '../state/time';
import { useWorld } from '../state/world';
import { grid } from '../state/ops';
import type { AlertRecord } from '@strata/domain';
import { Segmented } from '../components/ui';
import '../styles/forensics.css';
import '../styles/cameras.css';

interface SourceStatus {
  state: 'stopped' | 'connecting' | 'live' | 'error';
  lastFrameAt: number | null;
  lastError: string | null;
  framesReceived: number;
  framesAnalysed: number;
  framesDropped: number;
  width: number | null;
  height: number | null;
  analysisMs: number | null;
  restarts: number;
}

interface Source {
  id: string;
  name: string;
  binding: 'site' | 'new';
  urlMasked: string;
  scheme: string;
  enabled: boolean;
  pose: { lat: number; lon: number; heightM: number; headingDeg: number; pitchDeg: number; hfovDeg: number } | null;
  segment: string;
  zoneId: string | null;
  analyticsFps: number;
  detectObjects: boolean;
  recogniseFaces: boolean;
  tiled: boolean;
  loopFile: boolean;
  status: SourceStatus;
}

type Layout = 1 | 4 | 9 | 16;
type Filter = 'all' | 'live' | 'site' | 'alerting';

interface WallCam {
  id: string;
  name: string;
  kind: 'live' | 'site';
  source: Source | null;
  zoneName: string | null;
  restricted: boolean;
}

/**
 * CAMERA WALL — every camera on the site in one console: live streams analysed on site (RTSP/HTTP/recorded
 * files) and the site's camera estate. Tiles with an active alert flash; a guard tour cycles pages.
 */
export function Cameras() {
  const can = useSession((s) => s.can);
  const alerts = useData((s) => s.alerts);
  const [n, setN] = useState(0);
  const data = useAsync((s) => get<{ sources: Source[]; siteCameras: { id: string; name: string }[]; ffmpeg: boolean }>('/api/cameras', s), [n]);
  const [edit, setEdit] = useState<Source | 'new' | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>(() => (Number(localStorage.getItem('strata.wall.layout')) as Layout) || 9);
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const [tour, setTour] = useState(false);
  const [now, setNow] = useState(() => useTime.getState().currentLiveEdge());
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), 4000);
    const tk = setInterval(() => setNow(useTime.getState().currentLiveEdge()), 2000);
    return () => (clearInterval(id), clearInterval(tk));
  }, []);
  const sources = useMemo(() => data.data?.sources ?? [], [data.data]);
  const alerting = useMemo(() => {
    const m = new Map<string, AlertRecord>();
    for (const a of alerts) {
      if (a.status !== 'open') continue;
      const ids = new Set([...a.source.split(/,\s*/), ...a.evidence.map((e) => e.sensorId ?? '')]);
      for (const id of ids) if (id && !m.has(id)) m.set(id, a);
    }
    return m;
  }, [alerts]);
  const cams = useMemo<WallCam[]>(() => {
    const live = new Map(sources.map((s) => [s.id, s]));
    const zoneOf = (id: string | null) => FACILITY.zones.find((z) => z.id === id) ?? null;
    const out: WallCam[] = sources.map((s) => {
      const z = zoneOf(s.zoneId);
      return { id: s.id, name: s.name, kind: 'live', source: s, zoneName: z?.name ?? null, restricted: Boolean(z?.restricted) };
    });
    for (const c of FACILITY.sensors) {
      if (c.kind !== 'camera' || live.has(c.id)) continue;
      out.push({ id: c.id, name: c.name, kind: 'site', source: null, zoneName: null, restricted: false });
    }
    return out;
  }, [sources]);
  const alertingCount = cams.filter((c) => alerting.has(c.id)).length;
  const shown = cams.filter((c) => filter === 'all' || (filter === 'live' ? c.kind === 'live' : filter === 'site' ? c.kind === 'site' : alerting.has(c.id)));
  // Alerting cameras first, so nothing that matters sits on a later page.
  shown.sort((a, b) => Number(alerting.has(b.id)) - Number(alerting.has(a.id)));
  const pages = Math.max(1, Math.ceil(shown.length / layout));
  const pg = Math.min(page, pages - 1);
  useEffect(() => {
    if (!tour) return;
    const id = setInterval(() => setPage((p) => (p + 1) % pages), 12_000);
    return () => clearInterval(id);
  }, [tour, pages]);
  const setL = (l: Layout) => {
    setLayout(l);
    setPage(0);
    try {
      localStorage.setItem('strata.wall.layout', String(l));
    } catch {
      /* ignore */
    }
  };
  const tiles = shown.slice(pg * layout, pg * layout + layout);
  const cols = Math.sqrt(layout);
  const focused = cams.find((c) => c.id === focus) ?? null;
  return (
    <div className="page">
      <div className="page-h">
        <h1>Camera wall</h1>
        <span className="sub">
          {cams.length} cameras · {sources.filter((s) => s.status.state === 'live').length} live analysed streams ·{' '}
          {alertingCount ? <b style={{ color: 'var(--red)' }}>{alertingCount} alerting</b> : 'none alerting'}
        </span>
        <div className="spacer" />
        {data.data && !data.data.ffmpeg && <span className="err-inline">ffmpeg not installed — live streams unavailable</span>}
        <Segmented
          label="Filter"
          value={filter}
          onChange={(f) => (setFilter(f), setPage(0))}
          options={[
            { value: 'all', label: 'All' },
            { value: 'alerting', label: 'Alerting' },
            { value: 'live', label: 'Live streams' },
            { value: 'site', label: 'Site cameras' },
          ]}
        />
        <Segmented label="Layout" value={layout} onChange={setL} options={([1, 4, 9, 16] as Layout[]).map((l) => ({ value: l, label: `${Math.sqrt(l)}×${Math.sqrt(l)}` }))} />
        <button className={`btn small ${tour ? 'on' : ''}`} onClick={() => setTour(!tour)} title="Cycle through pages every 12 s">
          {tour ? <span className="live-dot" /> : null} Guard tour
        </button>
        {can('cameras.manage') && (
          <button className="btn primary small" onClick={() => setEdit('new')}>
            + Add stream
          </button>
        )}
      </div>
      <div className="page-body" style={{ gridTemplateColumns: focused ? '1fr 400px' : '1fr' }}>
        <div className="wall-wrap">
          {data.error && <ErrorNote error={data.error} />}
          {!data.data && <Loading />}
          {data.data && !shown.length && <div className="empty">{filter === 'alerting' ? 'No camera has an active alert.' : 'No cameras match this filter.'}</div>}
          <div className="wall" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${cols}, 1fr)` }}>
            {tiles.map((c) => (
              <WallTile key={c.id} c={c} t={now} alert={alerting.get(c.id) ?? null} selected={focus === c.id} onSelect={() => setFocus(focus === c.id ? null : c.id)} />
            ))}
          </div>
          {pages > 1 && (
            <div className="wall-pager">
              <button className="btn small" onClick={() => setPage((pg - 1 + pages) % pages)} aria-label="Previous page">
                ‹
              </button>
              {Array.from({ length: pages }, (_, i) => (
                <button key={i} className={`dot ${i === pg ? 'on' : ''}`} onClick={() => setPage(i)} aria-label={`Page ${i + 1}`} />
              ))}
              <button className="btn small" onClick={() => setPage((pg + 1) % pages)} aria-label="Next page">
                ›
              </button>
            </div>
          )}
        </div>
        {focused && <FocusPanel c={focused} alert={alerting.get(focused.id) ?? null} onClose={() => setFocus(null)} onEdit={() => focused.source && setEdit(focused.source)} onChanged={() => setN((x) => x + 1)} />}
      </div>
      {edit && data.data && (
        <CameraForm
          initial={edit === 'new' ? null : edit}
          siteCameras={data.data.siteCameras}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            setN((x) => x + 1);
          }}
        />
      )}
    </div>
  );
}

function WallTile({ c, t, alert, selected, onSelect }: { c: WallCam; t: number; alert: AlertRecord | null; selected: boolean; onSelect: () => void }) {
  const st = c.source?.status;
  const live = c.kind === 'site' || st?.state === 'live';
  return (
    <div className={`wtile ${alert ? `alerting p-${alert.priority}` : ''} ${selected ? 'sel' : ''}`} onClick={onSelect} role="button" tabIndex={0} aria-label={`${c.id} ${c.name}`} onKeyDown={(e) => e.key === 'Enter' && onSelect()}>
      <div className="wtile-v">
        {c.kind === 'site' ? (
          <CameraFeed sensorId={c.id} t={t} live compact />
        ) : st?.state === 'live' ? (
          <img src={`/api/cameras/${c.id}/mjpeg`} alt={`Live: ${c.name}`} />
        ) : (
          <div className={`camtile-off ${st?.state ?? ''}`}>
            <span className={st?.state === 'error' ? '' : 'spinner'} />
            {st?.state === 'error' ? (st.lastError ?? 'stream error') : c.source?.enabled ? 'connecting…' : 'disabled'}
          </div>
        )}
      </div>
      <div className="wtile-top">
        <span className={`wt-state ${live ? 'live' : (st?.state ?? '')}`}>
          {live && <span className="live-dot" style={{ width: 6, height: 6 }} />}
          {c.kind === 'live' ? (st?.state === 'live' ? 'LIVE · ANALYSED' : (st?.state ?? 'off').toUpperCase()) : 'SITE'}
        </span>
        <b className="mono">{c.id}</b>
        <span className="ellipsis">{c.name}</span>
      </div>
      {alert && (
        <div className="wtile-alert">
          <Icon.Alert /> <span className="ellipsis">{alert.title}</span>
        </div>
      )}
      <div className="wtile-bot mono">
        <span>{new Date(t).toISOString().slice(11, 19)}Z</span>
        {c.restricted && <span className="wt-zone">{c.zoneName}</span>}
        {st?.state === 'live' && <span className="dim">{st.analysisMs ? `${st.analysisMs} ms` : ''}</span>}
      </div>
    </div>
  );
}

function FocusPanel({ c, alert, onClose, onEdit, onChanged }: { c: WallCam; alert: AlertRecord | null; onClose: () => void; onEdit: () => void; onChanged: () => void }) {
  const can = useSession((s) => s.can);
  const nav = useNavigate();
  const [msg, setMsg] = useState<string | null>(null);
  const s = c.source;
  const def = FACILITY.sensors.find((x) => x.id === c.id);
  const showOnMap = () => {
    nav('/operations');
    const w = useWorld.getState();
    w.select({ kind: 'sensor', id: c.id });
    if (def && 'position' in def) w.flyTo(def.position, 220);
  };
  return (
    <aside className="focus-panel scroll reveal">
      <div className="panel-h">
        <h3>
          {c.id} · {c.kind === 'live' ? 'live stream' : 'site camera'}
        </h3>
        <span className="spacer" />
        <button className="btn ghost small icon" onClick={onClose} aria-label="Close">
          <Icon.Close />
        </button>
      </div>
      <div className="section">
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>{c.name}</div>
        {alert && (
          <div className="note warn" style={{ marginBottom: 8 }}>
            <b>{alert.priority.toUpperCase()}</b> · {alert.title}
          </div>
        )}
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <button className="btn small" onClick={showOnMap}>
            Show on map
          </button>
          {s && can('evidence.upload') && (
            <button
              className="btn small"
              disabled={s.status.state !== 'live'}
              onClick={() =>
                void post<{ item: { id: string } }>(`/api/cameras/${s.id}/capture`, {})
                  .then((r) => nav(`/forensics/${r.item.id}`))
                  .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)))
              }
            >
              Capture to evidence
            </button>
          )}
          {s && can('cameras.manage') && (
            <>
              <button className="btn small" onClick={() => void post(`/api/cameras/${s.id}/enable`, { enabled: !s.enabled }).then(onChanged)}>
                {s.enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="btn small ghost" onClick={onEdit}>
                Settings
              </button>
            </>
          )}
        </div>
        {msg && <div className="err-inline">{msg}</div>}
      </div>
      {s && (
        <div className="section">
          <h4>Stream</h4>
          <dl className="kv">
            <dt>Source</dt>
            <dd className="mono ellipsis" title={s.urlMasked}>
              {s.urlMasked}
            </dd>
            <dt>Resolution</dt>
            <dd className="mono">{s.status.width ? `${s.status.width}×${s.status.height}` : '—'}</dd>
            <dt>Analysis</dt>
            <dd className="mono">
              {s.analyticsFps} fps · {s.status.analysisMs ? `${s.status.analysisMs} ms/frame` : '—'}
            </dd>
            <dt>Frames</dt>
            <dd className="mono">
              {s.status.framesAnalysed} analysed · {s.status.framesDropped} dropped
            </dd>
            <dt>Last frame</dt>
            <dd className="mono">{ago(s.status.lastFrameAt, Date.now())}</dd>
            <dt>Reconnects</dt>
            <dd className="mono">{s.status.restarts}</dd>
          </dl>
        </div>
      )}
      {def && def.kind === 'camera' && (
        <div className="section">
          <h4>Calibrated pose</h4>
          <dl className="kv">
            <dt>Grid</dt>
            <dd className="mono">{grid(def.position)}</dd>
            <dt>Heading / tilt</dt>
            <dd className="mono">
              {Math.round(def.headingDeg)}° / {Math.round(def.pitchDeg)}°
            </dd>
            <dt>Field of view</dt>
            <dd className="mono">{Math.round(def.hfovDeg)}°</dd>
            <dt>Mast</dt>
            <dd className="mono">{def.mastHeightM} m</dd>
          </dl>
        </div>
      )}
      {s ? <CameraFaces id={c.id} /> : <div className="section muted" style={{ fontSize: 12 }}>Face recognition runs on analysed live streams. Site cameras in the demo report analytics only.</div>}
    </aside>
  );
}

function CameraFaces({ id }: { id: string }) {
  const fv = useVisionLive((s) => s.faceVersion);
  const can = useSession((s) => s.can);
  const faces = useAsync((s) => (can('identity.view') ? get<FaceEvent[]>(`/api/faces?source=${id}&limit=60`, s) : Promise.resolve([])), [id, fv]);
  return (
    <div className="section">
      <h4>Faces seen by {id}</h4>
      {!can('identity.view') && <div className="muted">Your role cannot view recognition results.</div>}
      {faces.data?.length === 0 && <div className="muted">None yet.</div>}
      <div className="col" style={{ gap: 8 }}>
        {faces.data?.map((ev) => (
          <FaceCard key={ev.id} ev={ev} />
        ))}
      </div>
    </div>
  );
}

function CameraForm({ initial, siteCameras, onClose, onSaved }: { initial: Source | null; siteCameras: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const files = useAsync((s) => get<{ dir: string; files: { name: string; bytes: number }[] }>('/api/cameras/import-files', s), []);
  const [f, setF] = useState({
    id: initial?.id ?? '',
    name: initial?.name ?? '',
    binding: initial?.binding ?? ('new' as 'site' | 'new'),
    url: '',
    enabled: initial?.enabled ?? true,
    lat: initial?.pose?.lat ?? FACILITY.origin.lat,
    lon: initial?.pose?.lon ?? FACILITY.origin.lon,
    heightM: initial?.pose?.heightM ?? 6,
    headingDeg: initial?.pose?.headingDeg ?? 0,
    pitchDeg: initial?.pose?.pitchDeg ?? -12,
    hfovDeg: initial?.pose?.hfovDeg ?? 70,
    zoneId: initial?.zoneId ?? '',
    analyticsFps: initial?.analyticsFps ?? 2,
    detectObjects: initial?.detectObjects ?? true,
    recogniseFaces: initial?.recogniseFaces ?? true,
    tiled: initial?.tiled ?? false,
    loopFile: initial?.loopFile ?? false,
  });
  const [test, setTest] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isFile = f.url !== '' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(f.url);
  const save = async () => {
    setErr(null);
    try {
      await post('/api/cameras', {
        id: f.id,
        name: f.name,
        binding: f.binding,
        ...(f.url ? { url: f.url } : {}),
        enabled: f.enabled,
        pose: f.binding === 'new' ? { lat: f.lat, lon: f.lon, heightM: f.heightM, headingDeg: f.headingDeg, pitchDeg: f.pitchDeg, hfovDeg: f.hfovDeg } : null,
        zoneId: f.zoneId || null,
        analyticsFps: f.analyticsFps,
        detectObjects: f.detectObjects,
        recogniseFaces: f.recogniseFaces,
        tiled: f.tiled,
        loopFile: isFile ? f.loopFile : false,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const num = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) });
  return (
    <Modal title={initial ? `Camera ${initial.id}` : 'Add camera'} onClose={onClose} wide>
      <div className="formgrid">
        <label>Binding</label>
        <Segmented
          label="Camera binding"
          value={f.binding}
          onChange={(b) => setF({ ...f, binding: b })}
          options={[
            { value: 'new', label: 'New camera on site', disabled: Boolean(initial) },
            { value: 'site', label: 'Drive existing site camera', disabled: Boolean(initial) },
          ]}
        />
        <label>Camera id</label>
        {f.binding === 'site' ? (
          <select className="input" value={f.id} disabled={Boolean(initial)} onChange={(e) => setF({ ...f, id: e.target.value, name: f.name || (siteCameras.find((c) => c.id === e.target.value)?.name ?? '') })}>
            <option value="">— choose —</option>
            {siteCameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} · {c.name}
              </option>
            ))}
          </select>
        ) : (
          <input className="input" value={f.id} disabled={Boolean(initial)} placeholder="e.g. GATE2-CAM1" onChange={(e) => setF({ ...f, id: e.target.value.toUpperCase() })} />
        )}
        <label>Name</label>
        <input className="input" value={f.name} placeholder="e.g. Gate 2 vehicle lane" onChange={(e) => setF({ ...f, name: e.target.value })} />
        <label>Stream</label>
        <div className="col">
          <div className="row">
            <input className="input grow" value={f.url} placeholder={initial ? `unchanged: ${initial.urlMasked} — re-enter to change` : 'rtsp://user:pass@10.0.4.21:554/Streaming/Channels/101'} onChange={(e) => setF({ ...f, url: e.target.value })} />
            <button
              className="btn small"
              disabled={!f.url}
              onClick={() => {
                setTest('testing…');
                void post<{ ok: boolean; width?: number; height?: number; error?: string }>('/api/cameras/test', { url: f.url })
                  .then((r) => setTest(r.ok ? `OK — ${r.width ?? '?'}×${r.height ?? '?'}` : `Failed: ${r.error}`))
                  .catch((e: unknown) => setTest(e instanceof Error ? e.message : String(e)));
              }}
            >
              Test
            </button>
          </div>
          {test && <span className="mono muted">{test}</span>}
          {files.data && files.data.files.length > 0 && (
            <div className="row muted" style={{ flexWrap: 'wrap', fontSize: 11.5 }}>
              Recorded files in <span className="mono">{files.data.dir}</span>:
              {files.data.files.map((x) => (
                <button key={x.name} className="btn small ghost" onClick={() => setF({ ...f, url: x.name, loopFile: true })}>
                  {x.name} ({bytes(x.bytes)})
                </button>
              ))}
            </div>
          )}
          <span className="dim" style={{ fontSize: 11 }}>
            Credentials in the URL are stored encrypted when a storage key is configured and are never shown again. Files must be in the import folder.
          </span>
        </div>
        {f.binding === 'new' && (
          <>
            <label>Position (WGS84)</label>
            <div className="row">
              <input className="input" type="number" step={0.000001} value={f.lat} onChange={num('lat')} style={{ width: 130 }} title="Latitude" />
              <input className="input" type="number" step={0.000001} value={f.lon} onChange={num('lon')} style={{ width: 130 }} title="Longitude" />
              <span className="muted">height above ground</span>
              <input className="input" type="number" step={0.1} value={f.heightM} onChange={num('heightM')} style={{ width: 70 }} />
              <span className="muted">m</span>
            </div>
            <label>Orientation</label>
            <div className="row">
              <span className="muted">heading</span>
              <input className="input" type="number" value={f.headingDeg} onChange={num('headingDeg')} style={{ width: 70 }} />
              <span className="muted">° · tilt</span>
              <input className="input" type="number" value={f.pitchDeg} onChange={num('pitchDeg')} style={{ width: 70 }} />
              <span className="muted">° · horizontal FOV</span>
              <input className="input" type="number" value={f.hfovDeg} onChange={num('hfovDeg')} style={{ width: 70 }} />
              <span className="muted">°</span>
            </div>
            <label />
            <span className="dim" style={{ fontSize: 11 }}>
              Survey these values (GNSS + compass/inclinometer, or from known landmarks). Geolocation of detections — and therefore tracks and zone alerts — is only as accurate as this pose.
            </span>
          </>
        )}
        <label>Watches zone</label>
        <select className="input" value={f.zoneId} onChange={(e) => setF({ ...f, zoneId: e.target.value })}>
          <option value="">— determine from geolocation —</option>
          {FACILITY.zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
              {z.restricted ? ' (restricted)' : ''}
            </option>
          ))}
        </select>
        <label>Analytics</label>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input className="input" type="number" min={0.2} max={10} step={0.1} value={f.analyticsFps} onChange={num('analyticsFps')} style={{ width: 70 }} />
          <span className="muted">frames/s</span>
          <label className="check">
            <input type="checkbox" checked={f.detectObjects} onChange={(e) => setF({ ...f, detectObjects: e.target.checked })} />
            people &amp; vehicles
          </label>
          <label className="check">
            <input type="checkbox" checked={f.recogniseFaces} onChange={(e) => setF({ ...f, recogniseFaces: e.target.checked })} />
            face recognition
          </label>
          <label className="check" title="Analyse in native-resolution tiles: finds small/distant people, costs ~6× CPU">
            <input type="checkbox" checked={f.tiled} onChange={(e) => setF({ ...f, tiled: e.target.checked })} />
            long-range (tiled)
          </label>
          {isFile && (
            <label className="check">
              <input type="checkbox" checked={f.loopFile} onChange={(e) => setF({ ...f, loopFile: e.target.checked })} />
              loop recording (rehearsal)
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
            enabled
          </label>
        </div>
      </div>
      {err && <ErrorNote error={err} />}
      <div className="row" style={{ marginTop: 12 }}>
        {initial && (
          <button className="btn danger" onClick={() => void api(`/api/cameras/${initial.id}`, { method: 'DELETE' }).then(onSaved)}>
            Remove
          </button>
        )}
        <div className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!f.id || !f.name || (!f.url && !initial)} onClick={() => void save()}>
          Save (audited)
        </button>
      </div>
    </Modal>
  );
}
