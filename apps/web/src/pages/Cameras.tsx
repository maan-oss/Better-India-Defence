import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Cctv, Smartphone } from 'lucide-react';
import { Button, ConfirmMorph, Input, NumberField, Pagination, RadioCards, Select as ArcSelect, SplitButton, Switch, useToastStack } from '../components/kit';
import { TickSlider } from '../components/vendor/spaceui/components/spaceui/tick-slider';
import { Empty } from '../brand/Boot';
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
  const [params, setParams] = useSearchParams();
  const [edit, setEdit] = useState<Source | 'new' | 'new-device' | null>(() => (params.get('add') && can('cameras.manage') ? (params.get('add') === 'device' ? 'new-device' : 'new') : null));
  useEffect(() => {
    if (params.get('add')) setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
        <div className="wall-tour" title="Cycle through pages every 12 s">
          <Switch label="Guard tour" checked={tour} disabled={pages < 2} onCheckedChange={setTour} />
        </div>
        {can('cameras.manage') && (
          <SplitButton
            label="Add camera"
            icon={<Cctv size={16} />}
            onClick={() => setEdit('new')}
            actions={[
              { label: 'Network camera (RTSP, HTTP or recorded file)', icon: <Cctv size={16} />, onSelect: () => setEdit('new') },
              { label: 'Use this device’s camera', icon: <Smartphone size={16} />, onSelect: () => setEdit('new-device') },
            ]}
          />
        )}
      </div>
      <div className="page-body" style={{ gridTemplateColumns: focused ? '1fr 400px' : '1fr' }}>
        <div className="wall-wrap">
          {data.error && <ErrorNote error={data.error} />}
          {!data.data && <Loading />}
          {data.data && !cams.length && (
            <Empty
              art="cameras"
              title="No cameras yet"
              description="Add an IP camera by its RTSP or HTTP address, or turn a phone, tablet or laptop into a camera. Every frame is analysed on this server for people and vehicles."
              action={
                can('cameras.manage') ? (
                  <div className="row" style={{ justifyContent: 'center' }}>
                    <Button variant="primary" onClick={() => setEdit('new')}>
                      <Cctv size={16} /> Add a network camera
                    </Button>
                    <Button variant="secondary" onClick={() => setEdit('new-device')}>
                      <Smartphone size={16} /> Use this device
                    </Button>
                  </div>
                ) : undefined
              }
            />
          )}
          {data.data && cams.length > 0 && !shown.length && <div className="empty">{filter === 'alerting' ? 'No camera has an active alert.' : 'No cameras match this filter.'}</div>}
          <div className="wall" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${cols}, 1fr)` }}>
            {tiles.map((c) => (
              <WallTile key={c.id} c={c} t={now} alert={alerting.get(c.id) ?? null} selected={focus === c.id} onSelect={() => setFocus(focus === c.id ? null : c.id)} />
            ))}
          </div>
          {pages > 1 && (
            <div className="wall-pager">
              <Pagination page={pg + 1} pageCount={pages} onPageChange={(p) => setPage(p - 1)} label="Camera wall pages" />
            </div>
          )}
        </div>
        {focused && <FocusPanel c={focused} alert={alerting.get(focused.id) ?? null} onClose={() => setFocus(null)} onEdit={() => focused.source && setEdit(focused.source)} onChanged={() => setN((x) => x + 1)} />}
      </div>
      {edit && data.data && (
        <CameraForm
          initial={edit === 'new' || edit === 'new-device' ? null : edit}
          startAs={edit === 'new-device' ? 'device' : 'network'}
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
  const { toast } = useToastStack();
  const [capturing, setCapturing] = useState(false);
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
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          <Icon.Close />
        </Button>
      </div>
      <div className="section">
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>{c.name}</div>
        {alert && (
          <div className="note warn" style={{ marginBottom: 8 }}>
            <b>{alert.priority.toUpperCase()}</b> · {alert.title}
          </div>
        )}
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <Button variant="secondary" size="sm" onClick={showOnMap}>
            Show on map
          </Button>
          {s && can('evidence.upload') && (
            <Button
              variant="secondary"
              size="sm"
              loading={capturing}
              disabled={s.status.state !== 'live'}
              onClick={() => {
                setCapturing(true);
                void post<{ item: { id: string } }>(`/api/cameras/${s.id}/capture`, {})
                  .then((r) => {
                    toast({ type: 'success', title: 'Frame preserved as evidence', description: `${s.id} · hashed and added to the evidence store` });
                    nav(`/forensics/${r.item.id}`);
                  })
                  .catch((e: unknown) => toast({ type: 'error', title: 'Capture failed', description: e instanceof Error ? e.message : String(e) }))
                  .finally(() => setCapturing(false));
              }}
            >
              Capture to evidence
            </Button>
          )}
          {s && can('cameras.manage') && (
            <Button variant="ghost" size="sm" onClick={onEdit}>
              Settings
            </Button>
          )}
          {s && s.scheme === 'device' && can('ops.log') && (
            <Button size="sm" onClick={() => nav(`/cameras/${encodeURIComponent(s.id)}/stream`)}>
              Stream from this device
            </Button>
          )}
        </div>
        {s && can('cameras.manage') && (
          <div style={{ marginTop: 12 }}>
            <Switch
              label={s.enabled ? 'Analysing this stream' : 'Stream disabled'}
              checked={s.enabled}
              onCheckedChange={(on) =>
                void post(`/api/cameras/${s.id}/enable`, { enabled: on })
                  .then(() => {
                    toast({ type: 'success', title: on ? `${s.id} enabled` : `${s.id} disabled`, description: 'Recorded in the audit log' });
                    onChanged();
                  })
                  .catch((e: unknown) => toast({ type: 'error', title: 'Not changed', description: e instanceof Error ? e.message : String(e) }))
              }
            />
          </div>
        )}
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

function CameraForm({ initial, startAs = 'network', siteCameras, onClose, onSaved }: { initial: Source | null; startAs?: 'network' | 'device'; siteCameras: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
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
  const [kind, setKind] = useState<'network' | 'device'>(initial ? (initial.scheme === 'device' ? 'device' : 'network') : startAs);
  const [locating, setLocating] = useState<string | null>(null);
  const nav = useNavigate();
  const device = kind === 'device';
  const isFile = !device && f.url !== '' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(f.url);
  const here = () => {
    if (!navigator.geolocation) return setLocating('This browser cannot report its location.');
    setLocating('Locating…');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setF((cur) => ({ ...cur, lat: Number(p.coords.latitude.toFixed(6)), lon: Number(p.coords.longitude.toFixed(6)) }));
        setLocating(`Located to ±${Math.round(p.coords.accuracy)} m`);
      },
      (e) => setLocating(e.code === e.PERMISSION_DENIED ? 'Location permission was refused.' : `Could not get a fix: ${e.message}`),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };
  const save = async () => {
    setErr(null);
    try {
      await post('/api/cameras', {
        id: f.id,
        name: f.name,
        binding: f.binding,
        ...(device && !initial ? { url: 'device:' } : f.url ? { url: f.url } : {}),
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
      if (device && !initial) nav(`/cameras/${encodeURIComponent(f.id)}/stream`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const [testing, setTesting] = useState(false);
  const runTest = () => {
    setTesting(true);
    setTest(null);
    void post<{ ok: boolean; width?: number; height?: number; error?: string }>('/api/cameras/test', { url: f.url })
      .then((r) => setTest(r.ok ? `Connected: ${r.width ?? '?'}×${r.height ?? '?'}` : `Failed: ${r.error}`))
      .catch((e: unknown) => setTest(e instanceof Error ? e.message : String(e)))
      .finally(() => setTesting(false));
  };
  return (
    <Modal title={initial ? `Camera ${initial.id}` : 'Add camera'} onClose={onClose} wide>
      <div className="camform">
        {!initial && (
          <section>
            <h4>Source</h4>
            <RadioCards
              aria-label="Camera source"
              layout="grid"
              minColumnWidth={320}
              value={kind}
              onValueChange={(k) => setKind(k as 'network' | 'device')}
              options={[
                { value: 'network', label: 'Network stream', icon: <Cctv size={16} />, description: 'An IP camera or NVR by RTSP or HTTP address, or a recorded file from the import folder.' },
                { value: 'device', label: 'This device’s camera', icon: <Smartphone size={16} />, description: 'A phone, tablet or laptop streams frames from its browser. Needs HTTPS or localhost.' },
              ]}
            />
            <RadioCards
              aria-label="Camera binding"
              layout="grid"
              minColumnWidth={320}
              value={f.binding}
              onValueChange={(b) => set('binding')(b as 'site' | 'new')}
              options={[
                { value: 'new', label: 'New camera on site', description: 'You give its position and orientation below.' },
                { value: 'site', label: 'Drive an existing site camera', description: 'Takes the calibrated pose already in the site configuration.', disabled: siteCameras.length === 0, disabledReason: 'The site configuration has no cameras.' },
              ]}
            />
          </section>
        )}
        <section>
          <h4>Identity</h4>
          <div className="camform-two">
            {f.binding === 'site' ? (
              <ArcSelect
                label="Site camera"
                placeholder="Choose a camera"
                value={f.id || undefined}
                disabled={Boolean(initial)}
                onValueChange={(v) => setF((cur) => ({ ...cur, id: v, name: cur.name || (siteCameras.find((c) => c.id === v)?.name ?? '') }))}
                options={siteCameras.map((c) => ({ value: c.id, label: `${c.id} · ${c.name}` }))}
              />
            ) : (
              <Input label="Camera ID" value={f.id} disabled={Boolean(initial)} placeholder="e.g. GATE2-CAM1" onChange={(e) => set('id')(e.target.value.toUpperCase())} />
            )}
            <Input label="Name" value={f.name} placeholder="e.g. Gate 2 vehicle lane" onChange={(e) => set('name')(e.target.value)} />
          </div>
        </section>
        <section>
          <h4>Stream</h4>
          {device ? (
            <p className="muted camform-note">
              After saving, this browser opens the camera and sends frames to the server for analysis. Any signed-in phone, tablet or laptop can stream to this camera from <span className="mono">/cameras/{f.id || 'ID'}/stream</span>.
            </p>
          ) : (
            <>
              <div className="camform-url">
                <Input
                  label="Address"
                  className="mono"
                  value={f.url}
                  placeholder={initial ? `unchanged: ${initial.urlMasked}` : 'rtsp://user:pass@10.0.4.21:554/Streaming/Channels/101'}
                  description="Credentials in the address are stored encrypted when a storage key is configured and are never shown again."
                  onChange={(e) => set('url')(e.target.value)}
                />
                <Button variant="secondary" disabled={!f.url} loading={testing} onClick={runTest}>
                  Test connection
                </Button>
              </div>
              {test && <div className={`camform-test ${test.startsWith('Connected') ? 'ok' : 'bad'}`}>{test}</div>}
              {files.data && files.data.files.length > 0 && (
                <div className="camform-files">
                  <span className="muted">
                    Recorded files in <span className="mono">{files.data.dir}</span>
                  </span>
                  {files.data.files.map((x) => (
                    <Button key={x.name} variant="ghost" size="sm" onClick={() => setF({ ...f, url: x.name, loopFile: true })}>
                      {x.name} · {bytes(x.bytes)}
                    </Button>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
        {f.binding === 'new' && (
          <section>
            <h4>Position and pose</h4>
            <div className="camform-grid">
              <NumberField label="Latitude" value={f.lat} onValueChange={set('lat')} min={-90} max={90} step={0.00001} formatOptions={{ maximumFractionDigits: 6, useGrouping: false }} />
              <NumberField label="Longitude" value={f.lon} onValueChange={set('lon')} min={-180} max={180} step={0.00001} formatOptions={{ maximumFractionDigits: 6, useGrouping: false }} />
              <NumberField label="Height above ground" value={f.heightM} onValueChange={set('heightM')} min={0} max={200} step={0.5} suffix=" m" />
              <NumberField label="Heading" value={f.headingDeg} onValueChange={set('headingDeg')} min={0} max={359} step={1} largeStep={15} suffix="°" scrub />
              <NumberField label="Tilt" value={f.pitchDeg} onValueChange={set('pitchDeg')} min={-90} max={30} step={1} suffix="°" scrub />
              <NumberField label="Horizontal field of view" value={f.hfovDeg} onValueChange={set('hfovDeg')} min={2} max={180} step={1} suffix="°" scrub />
            </div>
            <div className="row" style={{ marginTop: 10, gap: 10 }}>
              <Button variant="secondary" size="sm" onClick={here}>
                Use this device’s location
              </Button>
              {locating && <span className="muted" style={{ fontSize: 12 }}>{locating}</span>}
            </div>
            <p className="dim camform-note">Survey these values (GNSS and compass or inclinometer, or from known landmarks). Geolocation of detections, and so tracks and zone alerts, is only as accurate as this pose.</p>
          </section>
        )}
        <section>
          <h4>Analysis</h4>
          <div className="camform-two">
            <ArcSelect
              label="Watches zone"
              placeholder="Determine from geolocation"
              value={f.zoneId || '_auto'}
              onValueChange={(v) => set('zoneId')(v === '_auto' ? '' : v)}
              options={[{ value: '_auto', label: 'Determine from geolocation' }, ...FACILITY.zones.map((z) => ({ value: z.id, label: `${z.name}${z.restricted ? ' (restricted)' : ''}` }))]}
            />
            <div className="camform-fps">
              <span className="camform-label">Frames analysed per second</span>
              <TickSlider label="Frames analysed per second" value={f.analyticsFps} onChange={set('analyticsFps')} min={0.5} max={10} step={0.5} majorEvery={2} unit=" fps" />
              <span className="dim">CPU cost grows with rate. 2 fps finds people walking; raise it for vehicles.</span>
            </div>
          </div>
          <div className="camform-switches">
            <Switch label="Detect people and vehicles" checked={f.detectObjects} onCheckedChange={set('detectObjects')} />
            <Switch label="Recognise faces against the register" checked={f.recogniseFaces} onCheckedChange={set('recogniseFaces')} />
            <Switch label="Long range: analyse in full-resolution tiles (about 6× CPU)" checked={f.tiled} onCheckedChange={set('tiled')} />
            {isFile && <Switch label="Loop the recording (rehearsal)" checked={f.loopFile} onCheckedChange={set('loopFile')} />}
            <Switch label="Enabled" checked={f.enabled} onCheckedChange={set('enabled')} />
          </div>
        </section>
      </div>
      {err && <ErrorNote error={err} />}
      <div className="row camform-foot">
        {initial && (
          <ConfirmMorph
            label="Remove camera"
            prompt={`Remove ${initial.id}? Recorded evidence is kept.`}
            confirmLabel="Remove"
            pendingLabel="Removing"
            doneLabel="Removed"
            tone="danger"
            onConfirm={() => api(`/api/cameras/${initial.id}`, { method: 'DELETE' }).then(() => onSaved())}
          />
        )}
        <div className="spacer" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!f.id || !f.name || (!device && !f.url && !initial)} onClick={() => void save()}>
          {device && !initial ? 'Save and start streaming' : 'Save (audited)'}
        </Button>
      </div>
    </Modal>
  );
}
