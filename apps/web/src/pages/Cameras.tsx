import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FACILITY } from '@strata/domain';
import { api, get, post } from '../api/client';
import { useVisionLive, type FaceEvent } from '../api/vision';
import { useSession } from '../state/session';
import { ago, bytes } from '../lib/format';
import { ErrorNote, Loading, Modal, useAsync } from '../components/common';
import { FaceCard } from '../components/identity/FaceCard';
import '../styles/forensics.css';

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

/**
 * LIVE CAMERAS — real video sources (RTSP/HTTP or recorded files played as live) analysed on site.
 * Detections feed the same fusion and alerting as every other sensor; faces go to recognition.
 */
export function Cameras() {
  const can = useSession((s) => s.can);
  const [n, setN] = useState(0);
  const data = useAsync((s) => get<{ sources: Source[]; siteCameras: { id: string; name: string }[]; ffmpeg: boolean }>('/api/cameras', s), [n]);
  const [edit, setEdit] = useState<Source | 'new' | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), 4000);
    return () => clearInterval(id);
  }, []);
  const sources = data.data?.sources ?? [];
  return (
    <div className="page">
      <div className="page-h">
        <h1>Live Cameras</h1>
        <span className="sub">Real streams analysed on site: people, vehicles and faces. Frames are dropped, never queued, so what you see is current.</span>
        <div className="spacer" />
        {data.data && !data.data.ffmpeg && <span className="err-inline">ffmpeg not installed — live cameras unavailable</span>}
        {can('cameras.manage') && (
          <button className="btn primary" onClick={() => setEdit('new')}>
            + Add camera
          </button>
        )}
      </div>
      <div className="page-body" style={{ gridTemplateColumns: focus ? '1fr 420px' : '1fr' }}>
        <div className="scroll" style={{ padding: 14 }}>
          {data.error && <ErrorNote error={data.error} />}
          {!data.data && <Loading />}
          {data.data && !sources.length && (
            <div className="empty">
              No live sources yet. {can('cameras.manage') ? 'Add an RTSP/HTTP camera, or a recorded file from the import folder to rehearse analytics.' : 'An administrator can add cameras.'}
            </div>
          )}
          <div className="camwall">
            {sources.map((s) => (
              <CameraTile key={s.id} s={s} focused={focus === s.id} onFocus={() => setFocus(focus === s.id ? null : s.id)} onEdit={() => setEdit(s)} onChanged={() => setN((x) => x + 1)} />
            ))}
          </div>
        </div>
        {focus && <CameraFaces id={focus} />}
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

function CameraTile({ s, focused, onFocus, onEdit, onChanged }: { s: Source; focused: boolean; onFocus: () => void; onEdit: () => void; onChanged: () => void }) {
  const can = useSession((st) => st.can);
  const nav = useNavigate();
  const [msg, setMsg] = useState<string | null>(null);
  const zone = FACILITY.zones.find((z) => z.id === s.zoneId);
  const live = s.status.state === 'live';
  return (
    <div className={`camtile ${focused ? 'sel' : ''}`}>
      <div className="camtile-v" onClick={onFocus} role="button" tabIndex={0}>
        {live ? <img src={`/api/cameras/${s.id}/mjpeg`} alt={`Live: ${s.name}`} /> : <div className={`camtile-off ${s.status.state}`}>{s.status.state === 'error' ? s.status.lastError ?? 'error' : s.enabled ? 'connecting…' : 'disabled'}</div>}
        <span className={`camtile-state ${s.status.state}`}>{s.status.state.toUpperCase()}</span>
        {zone?.restricted && <span className="camtile-zone">{zone.name}</span>}
      </div>
      <div className="camtile-b">
        <div className="row">
          <b className="mono">{s.id}</b>
          <span className="ellipsis grow">{s.name}</span>
        </div>
        <div className="mono dim ellipsis" style={{ fontSize: 10.5 }} title={s.urlMasked}>
          {s.urlMasked}
        </div>
        <div className="mono dim" style={{ fontSize: 10.5 }}>
          {s.status.width ? `${s.status.width}×${s.status.height} · ` : ''}
          {s.status.framesAnalysed} analysed · {s.status.framesDropped} dropped · {s.status.analysisMs ? `${s.status.analysisMs} ms/frame` : '—'} · last {ago(s.status.lastFrameAt, Date.now())}
          {s.status.restarts ? ` · ${s.status.restarts} reconnects` : ''}
        </div>
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {can('evidence.upload') && (
            <button
              className="btn small"
              disabled={!live}
              onClick={() =>
                void post<{ item: { id: string } }>(`/api/cameras/${s.id}/capture`, {})
                  .then((r) => nav(`/forensics/${r.item.id}`))
                  .catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)))
              }
            >
              Capture to evidence
            </button>
          )}
          {can('cameras.manage') && (
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
        {msg && <span className="err-inline">{msg}</span>}
      </div>
    </div>
  );
}

function CameraFaces({ id }: { id: string }) {
  const fv = useVisionLive((s) => s.faceVersion);
  const can = useSession((s) => s.can);
  const faces = useAsync((s) => (can('identity.view') ? get<FaceEvent[]>(`/api/faces?source=${id}&limit=60`, s) : Promise.resolve([])), [id, fv]);
  return (
    <div className="scroll" style={{ borderLeft: '1px solid var(--line)', padding: 12 }}>
      <div className="panel-h" style={{ padding: 0, marginBottom: 8 }}>
        <h3>Faces seen by {id}</h3>
      </div>
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
        <div className="seg">
          <button className={f.binding === 'new' ? 'on' : ''} onClick={() => setF({ ...f, binding: 'new' })} disabled={Boolean(initial)}>
            NEW CAMERA ON SITE
          </button>
          <button className={f.binding === 'site' ? 'on' : ''} onClick={() => setF({ ...f, binding: 'site' })} disabled={Boolean(initial)}>
            DRIVE EXISTING SITE CAMERA
          </button>
        </div>
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
