import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, qs } from '../api/client';
import type { Coverage, DiffResponse, IncidentPackage } from '../api/types';
import { useWorld } from '../state/world';
import { useTime } from '../state/time';
import { useData } from '../state/data';
import { useSession } from '../state/session';
import { dateTime, dur, hms, pct, titleCase } from '../lib/format';
import { ErrorNote, Loading, Prio, StateChip, useAsync } from './common';
import { VirtualList } from './VirtualList';
import { tracks as trackStore, type RenderTrack } from '../state/tracks';

export function IncidentPanel({ id }: { id: string }) {
  const { data, error } = useAsync((s) => get<IncidentPackage>(`/api/incidents/${encodeURIComponent(id)}`, s), [id]);
  const select = useWorld((s) => s.select);
  const flyTo = useWorld((s) => s.flyTo);
  const nav = useNavigate();
  const [loop, setLoop] = useState(true);
  // Loop replay inside the incident window.
  useEffect(() => {
    if (!data || !loop) return;
    const t = useTime.getState();
    const from = data.window.from;
    const to = Math.min(data.window.to, t.currentLiveEdge());
    if (t.mode === 'live' || t.t < from || t.t > to) {
      t.seek(from);
      t.setRate(4);
      t.setDirection(1);
      t.setPlaying(true);
    }
    const id2 = setInterval(() => {
      const s = useTime.getState();
      if (s.t > to || s.mode === 'live') {
        s.seek(from);
        s.setPlaying(true);
      }
    }, 500);
    return () => clearInterval(id2);
  }, [data, loop]);
  useEffect(() => {
    if (data) flyTo(data.incident.center, Math.max(500, data.incident.radiusM * 2.6), undefined, -48);
  }, [data, flyTo]);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading what="incident evidence" />;
  const inc = data.incident;
  return (
    <div>
      <div className="inspector-title">
        <div className="kind">Incident reconstruction · {inc.status}</div>
        <h2>
          {inc.code} — {inc.title}
        </h2>
        <div className="muted mono" style={{ fontSize: 11.5 }}>
          {dateTime(inc.tStart)} → {hms(inc.tEnd)}Z · radius {Math.round(inc.radiusM)} m
        </div>
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <button className={`btn small ${loop ? 'on' : ''}`} onClick={() => setLoop(!loop)}>
            {loop ? 'Looping replay ×4' : 'Loop replay'}
          </button>
          <button className="btn small" onClick={() => nav(`/incidents/${inc.id}`)}>
            Investigation file
          </button>
          {data.snapshots.map((s) => (
            <button key={s.label} className="btn small ghost" onClick={() => (setLoop(false), useTime.getState().seek(s.t), useTime.getState().setPlaying(false))}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {data.stoppedBefore.length > 0 && (
        <div className="ledger">
          <h5>Sensors not reporting at incident start</h5>
          {data.stoppedBefore.map((s) => (
            <div key={`${s.sensorId}${s.t}`} className="ev-row">
              <span className="ev-link" onClick={() => select({ kind: 'sensor', id: s.sensorId })}>
                {s.sensorId}
              </span>
              <span className="mono">{s.status}</span>
              <div className="meta">
                from {hms(s.t)}Z · {s.restoredAt ? `restored ${hms(s.restoredAt)}Z` : 'not restored'}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="ledger">
        <h5>Nearby sensors ({data.sensors.length})</h5>
        {data.sensors.map((s) => (
          <div key={s.sensorId} className="ev-row" style={{ cursor: 'pointer' }} onClick={() => select({ kind: 'sensor', id: s.sensorId })}>
            <span>
              {s.sensorId} <span className="muted">{s.kind}</span>
            </span>
            <span className="mono">{s.observations}</span>
            <div className="meta">{s.reason}</div>
          </div>
        ))}
      </div>
      <div className="ledger">
        <h5>Tracks in area ({data.tracks.length})</h5>
        {data.tracks.map((t) => (
          <div key={t.id} className="ev-row" style={{ cursor: 'pointer' }} onClick={() => (select({ kind: 'track', id: t.id }), useTime.getState().seek(t.firstT))}>
            <span>
              {t.id} <span className="muted">{t.cooperative ? t.label : t.category}</span>
            </span>
            <span className="mono">{t.minDistanceM} m</span>
            <div className="meta">
              {hms(t.firstT)}–{hms(t.lastT)}Z
            </div>
          </div>
        ))}
      </div>
      <div className="ledger">
        <h5>Alerts ({data.alerts.length})</h5>
        {data.alerts.map((a) => (
          <div key={a.id} className="ev-row" style={{ cursor: 'pointer' }} onClick={() => select({ kind: 'alert', id: a.id })}>
            <span className="row">
              <Prio p={a.priority} /> {a.title}
            </span>
            <span className="mono muted">{hms(a.t)}</span>
          </div>
        ))}
      </div>
      {data.changes.length > 0 && (
        <div className="ledger">
          <h5>World changes</h5>
          {data.changes.map((c) => (
            <div key={c.id} className="ev-row" style={{ cursor: 'pointer' }} onClick={() => select({ kind: 'change', id: c.id })}>
              <span>{c.title}</span>
              <span className="mono muted">{hms(c.t)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DiffPanel() {
  const diff = useWorld((s) => s.diff);
  const setDiff = useWorld((s) => s.setDiff);
  const show = useWorld((s) => s.diffShow);
  const setShow = useWorld((s) => s.setDiffShow);
  const select = useWorld((s) => s.select);
  const flyTo = useWorld((s) => s.flyTo);
  useEffect(() => {
    if (!diff) {
      const edge = useTime.getState().currentLiveEdge();
      setDiff({ a: Math.max(useTime.getState().rangeFrom, edge - 60 * 60_000), b: edge - 5000 });
    }
  }, [diff, setDiff]);
  const a = diff ? Math.round(diff.a / 10_000) * 10_000 : 0;
  const b = diff ? Math.round(diff.b / 10_000) * 10_000 : 0;
  const { data, error } = useAsync((s) => (diff ? get<DiffResponse>(`/api/replay/diff?${qs({ a, b })}`, s) : Promise.resolve(null)), [a, b]);
  useEffect(() => {
    if (diff) useTime.getState().seek(show === 'A' ? Math.min(diff.a, diff.b) : Math.max(diff.a, diff.b));
    useTime.getState().setPlaying(false);
  }, [show, diff]);
  if (!diff) return null;
  return (
    <div>
      <div className="inspector-title">
        <div className="kind">Reality diff</div>
        <h2>
          {hms(Math.min(diff.a, diff.b))} → {hms(Math.max(diff.a, diff.b))}Z
        </h2>
        <div className="muted">Δ {dur(Math.abs(diff.b - diff.a))}. Compares what the platform knew at A with what it knew at B — never simulator truth.</div>
        <div className="row" style={{ marginTop: 8 }}>
          <div className="seg">
            <button className={show === 'A' ? 'on' : ''} onClick={() => setShow('A')}>
              SHOW A
            </button>
            <button className={show === 'B' ? 'on' : ''} onClick={() => setShow('B')}>
              SHOW B
            </button>
          </div>
          <span className="muted" style={{ fontSize: 11.5 }}>
            World reflects the selected side.
          </span>
        </div>
      </div>
      {error && <ErrorNote error={error} />}
      {!data && !error && <Loading what="diff" />}
      {data && (
        <>
          <div className="ledger">
            <h5>Detected change events ({data.detectedChanges.length})</h5>
            {data.detectedChanges.length === 0 && <div className="muted">No change events detected between A and B.</div>}
            {data.detectedChanges.map((c) => (
              <div key={c.id} className="ev-row" style={{ cursor: 'pointer' }} onClick={() => (select({ kind: 'change', id: c.id }), flyTo(c.position, Math.max(140, c.extentM * 6)))}>
                <span>{c.title}</span>
                <StateChip state={c.state} />
                <div className="meta">
                  {hms(c.t)}Z · {titleCase(c.kind)} · {c.detector} · support {pct(c.confidence)}
                </div>
              </div>
            ))}
          </div>
          <div className="ledger">
            <h5>State differences A → B ({data.entries.length})</h5>
            {data.entries.map((e, i) => (
              <div key={i} className="ev-row" style={{ cursor: e.position ? 'pointer' : 'default' }} onClick={() => e.position && flyTo(e.position, 220)}>
                <span>{e.title}</span>
                <span className="muted">{titleCase(e.kind)}</span>
                {(e.before || e.after) && (
                  <div className="meta mono">
                    {e.before ?? '∅'} → {e.after ?? '∅'}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="ledger">
            <h5>Overhead imagery</h5>
            {data.imagery.before && data.imagery.after && data.imagery.before.id !== data.imagery.after.id ? (
              <ImageryCompare before={data.imagery.before} after={data.imagery.after} />
            ) : (
              <div className="muted">
                {data.imagery.after ? `Only one capture (${hms(data.imagery.after.t)}Z) precedes B — no imagery comparison possible.` : 'No overhead captures in this period.'} Imagery arrives at its acquisition cadence; it is never continuous.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ImageryCompare({ before, after }: { before: { id: string; t: number; mediaId: string }; after: { id: string; t: number; mediaId: string } }) {
  const [k, setK] = useState(50);
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>({ x: 0.39, y: 0.45 });
  const img = (zoom ? { transform: 'scale(4)', transformOrigin: `${zoom.x * 100}% ${zoom.y * 100}%` } : {}) as React.CSSProperties;
  return (
    <div className="col">
      <div
        className="compare"
        style={{ aspectRatio: '1 / 1' }}
        onDoubleClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setZoom(zoom ? null : { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
        }}
      >
        <img src={`/api/media/${encodeURIComponent(after.mediaId)}`} alt="later capture" style={{ ...img, position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        <img src={`/api/media/${encodeURIComponent(before.mediaId)}`} alt="earlier capture" style={{ ...img, position: 'absolute', inset: 0, width: '100%', height: '100%', clipPath: `inset(0 ${100 - k}% 0 0)` }} />
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${k}%`, width: 1, background: 'var(--text-0)' }} />
        <input type="range" min={0} max={100} value={k} onChange={(e) => setK(Number(e.target.value))} aria-label="Before/after split" />
      </div>
      <div className="row muted mono" style={{ fontSize: 11 }}>
        <span>◀ earlier {hms(before.t)}Z</span>
        <span className="spacer" />
        <span>later {hms(after.t)}Z ▶</span>
      </div>
      <div className="dim" style={{ fontSize: 11 }}>
        Acquisition times shown. Double-click toggles 4× zoom. 4 m GSD — people are not resolvable.
      </div>
    </div>
  );
}

export function CoveragePanel() {
  const coverage = useData((s) => s.coverage);
  const patches = useWorld((s) => s.patches);
  const select = useWorld((s) => s.select);
  const flyTo = useWorld((s) => s.flyTo);
  const rows = useMemo(() => {
    if (!coverage) return [];
    const byId = new Map(patches.map((p) => [p.id, p]));
    return coverage.patches
      .map((r) => ({ r, p: byId.get(r[0]) }))
      .filter((x) => x.p && (x.p.kind === 'wall' || x.p.kind === 'roof'))
      .sort((a, b) => a.r[1] - b.r[1])
      .slice(0, 40);
  }, [coverage, patches]);
  const stats = useMemo(() => summarise(coverage, patches), [coverage, patches]);
  return (
    <div>
      <div className="inspector-title">
        <div className="kind">Coverage & uncertainty</div>
        <h2>What the platform does not know</h2>
        <div className="muted">Support combines calibrated camera visibility, LiDAR returns and overhead imagery, decayed by age. Hatched ground was never observed in the last 6 h. Interiors are always unknown.</div>
      </div>
      <div className="ledger">
        <div className="legend" style={{ padding: 0 }}>
          <div className="ramp" />
          <div className="row mono dim" style={{ fontSize: 10.5 }}>
            <span>0%</span>
            <span className="spacer" />
            <span>support</span>
            <span className="spacer" />
            <span>100%</span>
          </div>
        </div>
        {stats && (
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Exterior surfaces</dt>
            <dd className="mono">{stats.surfaces}</dd>
            <dt>Never observed</dt>
            <dd className="mono">
              {stats.unobserved} ({pct(stats.unobserved / Math.max(1, stats.surfaces))})
            </dd>
            <dt>Support ≥ 80%</dt>
            <dd className="mono">{stats.high}</dd>
            <dt>Ground observed</dt>
            <dd className="mono">{pct(stats.groundObserved)}</dd>
            <dt>Interiors unknown</dt>
            <dd className="mono">{stats.interiors}</dd>
          </dl>
        )}
      </div>
      <div className="ledger">
        <h5>Lowest support surfaces</h5>
        {!coverage && <Loading />}
        {rows.map(({ r, p }) => (
          <div key={r[0]} className="ev-row" style={{ cursor: 'pointer' }} onClick={() => (select({ kind: 'patch', id: r[0], buildingId: p!.ownerId }), flyTo(p!.center, 120))}>
            <span className="ellipsis">{p!.label}</span>
            <span className="mono">{pct(r[1])}</span>
            <div className="meta">{r[4] ? `last observed ${hms(r[4])}Z` : r[5] === 3 ? 'design data only — never confirmed' : 'never observed'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function summarise(c: Coverage | null, patches: { id: string; kind: string }[]) {
  if (!c) return null;
  const kind = new Map(patches.map((p) => [p.id, p.kind]));
  let surfaces = 0;
  let unobserved = 0;
  let high = 0;
  let ground = 0;
  let groundObs = 0;
  let interiors = 0;
  for (const r of c.patches) {
    const k = kind.get(r[0]);
    if (k === 'interior') interiors++;
    else if (k === 'ground') {
      ground++;
      if (r[4]) groundObs++;
    } else {
      surfaces++;
      if (!r[4]) unobserved++;
      if (r[1] >= 0.8) high++;
    }
  }
  return { surfaces, unobserved, high, groundObserved: ground ? groundObs / ground : 0, interiors };
}

export function EvidenceModePanel() {
  return (
    <div>
      <div className="inspector-title">
        <div className="kind">Evidence mode</div>
        <h2>Every surface traceable to evidence</h2>
        <div className="muted">Surfaces are tinted by epistemic state. Select any wall, roof or ground point to open its ledger.</div>
      </div>
      <div className="ledger col">
        <div className="row">
          <StateChip state="CAPTURED" /> <span className="muted">appearance observed directly by imaging sensors</span>
        </div>
        <div className="row">
          <StateChip state="RECONSTRUCTED" /> <span className="muted">geometry derived from range / multi-view observations</span>
        </div>
        <div className="row">
          <StateChip state="INFERRED" /> <span className="muted">model estimate — never shown as fact</span>
        </div>
        <div className="row">
          <StateChip state="PRIOR" /> <span className="muted">design data, not confirmed by any sensor</span>
        </div>
        <div className="row">
          <StateChip state="UNKNOWN" /> <span className="muted">no information; left empty</span>
        </div>
      </div>
    </div>
  );
}

/** Default context: alerts, active tracks, recent changes. */
export function Overview() {
  const [tab, setTab] = useState<'alerts' | 'tracks' | 'changes'>('alerts');
  const alerts = useData((s) => s.alerts);
  const changes = useData((s) => s.changes);
  const select = useWorld((s) => s.select);
  const flyTo = useWorld((s) => s.flyTo);
  const can = useSession((s) => s.can);
  const [list, setList] = useState<RenderTrack[]>([]);
  useEffect(() => {
    const id = setInterval(() => {
      const t = useTime.getState();
      setList(t.mode === 'live' ? trackStore.liveAt(t.currentLiveEdge()) : trackStore.replayAt(t.t));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  const openAlerts = alerts.filter((a) => a.status === 'open' || a.status === 'acknowledged');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="ctx-tabs" role="tablist">
        <button role="tab" className={tab === 'alerts' ? 'on' : ''} onClick={() => setTab('alerts')}>
          Alerts {openAlerts.length}
        </button>
        <button role="tab" className={tab === 'tracks' ? 'on' : ''} onClick={() => setTab('tracks')}>
          Tracks {list.length}
        </button>
        <button role="tab" className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
          Changes
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'alerts' && (
          <VirtualList
            items={alerts}
            rowHeight={52}
            empty="No alerts."
            render={(a) => (
              <div className="list-row" style={{ height: 52, opacity: a.status === 'resolved' || a.status === 'dismissed' ? 0.5 : 1 }} onClick={() => (select({ kind: 'alert', id: a.id }), a.position && flyTo(a.position, 260), useTime.getState().seek(a.t))}>
                <Prio p={a.priority} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis">{a.title}</div>
                  <div className="muted mono" style={{ fontSize: 11 }}>
                    {hms(a.t)}Z · {a.rule} · {a.status}
                  </div>
                </div>
                {can('alerts.acknowledge') && a.status === 'open' && (
                  <button
                    className="btn small"
                    onClick={(e) => {
                      e.stopPropagation();
                      void post(`/api/alerts/${a.id}/ack`).then((r) => useData.getState().onLive({ type: 'alert', alert: r as typeof a }));
                    }}
                  >
                    Ack
                  </button>
                )}
              </div>
            )}
          />
        )}
        {tab === 'tracks' && (
          <VirtualList
            items={list.sort((a, b) => Number(a.cooperative) - Number(b.cooperative) || a.id.localeCompare(b.id))}
            rowHeight={44}
            empty="No active tracks at this time."
            render={(t) => (
              <div className="list-row" style={{ height: 44 }} onClick={() => (select({ kind: 'track', id: t.id }), flyTo(t.position, 180))}>
                <span className="mono" style={{ width: 52 }}>
                  {t.id}
                </span>
                <div className="grow ellipsis">
                  {t.cooperative ? t.label : t.classification} <span className="muted">{t.contributors.join(' ')}</span>
                </div>
                <StateChip state={t.inferred ? 'INFERRED' : 'RECONSTRUCTED'} label={t.status} />
              </div>
            )}
          />
        )}
        {tab === 'changes' && (
          <VirtualList
            items={changes.filter((c) => c.kind !== 'sensor_restored')}
            rowHeight={48}
            empty="No changes recorded."
            render={(c) => (
              <div className="list-row" style={{ height: 48 }} onClick={() => (select({ kind: 'change', id: c.id }), flyTo({ x: c.x, y: c.y, z: c.z }, Math.max(150, c.extent_m * 6)))}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis">{c.title}</div>
                  <div className="muted mono" style={{ fontSize: 11 }}>
                    {hms(c.t)}Z · {c.detector}
                  </div>
                </div>
                <StateChip state={c.state} />
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
